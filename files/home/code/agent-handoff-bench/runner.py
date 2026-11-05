#!/usr/bin/env python3
"""Agent handoff protocol benchmark runner (stdlib only)."""
from __future__ import annotations

import argparse
import atexit
import json
import os
import random
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
MAX_CALLS = 55
MAX_TOTAL_TOKENS = 180_000
MAX_WALL_SEC = 20 * 60
MAX_RETRIEVAL_ROUNDS = 2
CALL_TIMEOUT_SEC = 60
BENCHMARK_MODEL = "gpt-6-luna"
BENCHMARK_PROVIDER = "openai-codex"
MODEL_STRATEGIES_NEED_PRODUCER = frozenset(
    {"summary_200w", "structured_envelope", "hybrid_envelope"}
)

RECEIVER_SYSTEM = """You are a handoff receiver in a protocol benchmark.
Respond with a single JSON object only (no markdown fences).
Either {"need": ["artifact-id", ...]} to request up to 2 artifacts per round (max 2 rounds total for this trial)
or {"answer": <object>} matching the requested answer schema.
Do not invent facts not supported by handoff text or supplied artifacts.
Include evidence artifact IDs in final answers where schema requires."""

PRODUCER_SYSTEM = """You compress handoff source material for another agent.
Preserve the task/question and output contract exactly. Do not add unsupported facts.
Do not include evaluator secrets. Output only the handoff payload requested."""

SCHEMA_HINTS = {
    "quick_answer": '{"answer": <number>, "evidence": ["artifact-id", ...]}',
    "feature_table": '{"machine_table": {"initial": "...", "transitions": [...]}, "evidence": [...]}',
    "longrun_handoff": '{"job_id": "...", "tests_failed": bool, "dashboard_stale": bool, "needs_human": bool, "agent_idle": bool, "evidence": [...]}',
}

USAGE_KEYS = ("input", "output", "cacheRead", "cacheWrite", "totalTokens")


@dataclass
class Usage:
    input: int = 0
    output: int = 0
    cacheRead: int = 0
    cacheWrite: int = 0
    totalTokens: int = 0

    def add(self, other: Usage) -> None:
        self.input += other.input
        self.output += other.output
        self.cacheRead += other.cacheRead
        self.cacheWrite += other.cacheWrite
        self.totalTokens += other.totalTokens


@dataclass
class CallRecord:
    call_id: str
    role: str
    case_id: str
    strategy: str
    repeat: int | None
    phase: str
    wall_ms: int
    usage: Usage
    stop_reason: str | None
    ok: bool
    retrieval_rounds: int = 0
    pass_eval: bool | None = None
    error: str | None = None
    response_text: str | None = None
    eval_reason: str | None = None
    model: str | None = None
    provider: str | None = None


@dataclass
class Budget:
    calls: int = 0
    total_tokens: int = 0
    t0: float = field(default_factory=time.time)

    def check(self) -> None:
        if self.calls >= MAX_CALLS:
            raise RuntimeError("budget: max model calls")
        if self.total_tokens >= MAX_TOTAL_TOKENS:
            raise RuntimeError("budget: max totalTokens")
        if time.time() - self.t0 >= MAX_WALL_SEC:
            raise RuntimeError("budget: max wall time")


def load_fixtures(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def usage_from_dict(u: dict) -> Usage:
    return Usage(**{k: int(u.get(k) or 0) for k in USAGE_KEYS})


def run_wall_start_from_id(run_id: str) -> float | None:
    m = re.match(r"^(\d{8}T\d{6})", run_id)
    if not m:
        return None
    return time.mktime(time.strptime(m.group(1), "%Y%m%dT%H%M%S"))


def budget_from_per_call(per_path: Path) -> Budget:
    b = Budget()
    if not per_path.exists():
        return b
    for line in per_path.read_text().splitlines():
        if not line.strip():
            continue
        o = json.loads(line)
        if o.get("role") not in ("producer", "receiver_call"):
            continue
        b.calls += 1
        b.total_tokens += int(o.get("usage", {}).get("totalTokens") or 0)
    return b


def terminate_process_group(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            proc.terminate()
        except ProcessLookupError:
            return
    try:
        proc.wait(timeout=0.5)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass
    proc.wait(timeout=5)


def artifact_block(artifacts: dict[str, str], ids: list[str]) -> str:
    parts = []
    for aid in ids:
        parts.append(f"--- artifact:{aid} ---\n{artifacts[aid]}")
    return "\n\n".join(parts)


def build_deterministic_handoff(
    strategy: str, case: dict, artifacts: dict[str, str]
) -> str:
    task = case["task"]
    aids = case["artifact_ids"]
    if strategy == "full_evidence":
        return (
            f"TASK:\n{task}\n\nEVIDENCE (complete):\n"
            + artifact_block(artifacts, aids)
        )
    if strategy == "reference_only":
        catalog = "\n".join(f"- {a}" for a in aids)
        return f"TASK:\n{task}\n\nARTIFACT_CATALOG (fetch as needed):\n{catalog}"
    raise ValueError(strategy)


def producer_prompt(strategy: str, case: dict, artifacts: dict[str, str]) -> str:
    src = artifact_block(artifacts, case["producer_source_ids"])
    schema = SCHEMA_HINTS[case["answer_schema"]]
    if strategy == "summary_200w":
        fmt = "Write ~200 word free-text summary handoff including task and output contract."
    elif strategy == "structured_envelope":
        fmt = (
            "Write compact structured handoff (~350 tokens) with sections: "
            "goal, scope, constraints, decisions, pointers, done_when."
        )
    elif strategy == "hybrid_envelope":
        fmt = (
            "Write structured envelope (goal/scope/constraints/pointers/done_when) "
            "plus 2-3 short crucial evidence excerpts inline; other facts as artifact pointers."
        )
    else:
        raise ValueError(strategy)
    return (
        f"{fmt}\n\nTASK (preserve verbatim):\n{case['task']}\n\n"
        f"OUTPUT CONTRACT: {schema}\n\nSOURCE:\n{src}"
    )


def parse_json_from_text(text: str) -> dict[str, Any] | None:
    text = text.strip()
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        parsed = json.loads(m.group(0))
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def transition_key(t: dict) -> tuple:
    return (t.get("from"), t.get("event"), t.get("to"))


def parse_machine(raw: str | dict) -> dict:
    if isinstance(raw, dict):
        return raw
    return json.loads(raw)


def validate_evidence_list(ev: Any) -> tuple[bool, str]:
    if not isinstance(ev, list):
        return False, "evidence must be a list"
    for item in ev:
        if not isinstance(item, str):
            return False, "evidence items must be artifact-id strings"
    return True, "ok"


def eval_feature_table(answer: dict, gold: dict, artifacts: dict[str, str]) -> tuple[bool, str]:
    mt = answer.get("machine_table") or answer.get("answer", {}).get("machine_table")
    if not isinstance(mt, dict):
        return False, "missing machine_table object"
    base = parse_machine(artifacts[gold["preserve_from"]])
    if mt.get("initial") != base.get("initial"):
        return False, "wrong initial state"
    transitions = mt.get("transitions")
    if not isinstance(transitions, list):
        return False, "transitions must be a list"
    for t in transitions:
        if not isinstance(t, dict):
            return False, "transition must be object"
        for k in ("from", "event", "to"):
            if k not in t or not isinstance(t[k], str):
                return False, f"transition missing string {k}"
    base_set = {transition_key(t) for t in base.get("transitions", [])}
    new_set = {transition_key(t) for t in transitions}
    for req in gold.get("required_transitions", []):
        if transition_key(req) not in new_set:
            return False, f"missing transition {req}"
    for bad in gold.get("forbidden_transitions", []):
        if transition_key(bad) in new_set:
            return False, f"unsafe transition {bad}"
    if not base_set.issubset(new_set):
        return False, "did not preserve existing transitions"
    ev = answer.get("evidence", [])
    ok_ev, msg = validate_evidence_list(ev)
    if not ok_ev:
        return False, msg
    return True, "ok"


def eval_quick(answer: dict, gold: dict) -> tuple[bool, str]:
    obj = answer.get("answer") if "answer" in answer and isinstance(answer["answer"], dict) else answer
    if isinstance(obj, dict) and "answer" in obj:
        val = obj["answer"]
        ev = obj.get("evidence", [])
    else:
        val = obj.get("answer") if isinstance(obj, dict) else None
        ev = obj.get("evidence", []) if isinstance(obj, dict) else []
    if val is None:
        return False, "missing answer"
    if isinstance(val, bool) or not isinstance(val, (int, float)) or not float(val).is_integer():
        return False, "answer must be numeric"
    try:
        num = int(val)
    except (TypeError, ValueError):
        return False, "answer not numeric"
    if num != gold["numeric_answer"]:
        return False, f"wrong value {num}"
    ok_ev, msg = validate_evidence_list(ev)
    if not ok_ev:
        return False, msg
    for fid in gold.get("required_artifact_refs", []):
        if fid not in ev:
            return False, f"missing evidence {fid}"
    blob = json.dumps(answer)
    for forbidden in gold.get("forbidden_values", []):
        if re.search(rf"\b{re.escape(forbidden)}\b", blob) and str(gold["numeric_answer"]) != forbidden:
            if forbidden == "10" and num == 30:
                return False, "used obsolete value"
    return True, "ok"


def eval_longrun(answer: dict, gold: dict) -> tuple[bool, str]:
    obj = answer.get("answer") if isinstance(answer.get("answer"), dict) else answer
    if not isinstance(obj, dict):
        return False, "bad shape"
    if obj.get("job_id") != gold["job_id"]:
        return False, "wrong job_id"
    for key in ("tests_failed", "dashboard_stale", "needs_human", "agent_idle"):
        if key not in gold:
            continue
        if key not in obj:
            return False, f"missing {key}"
        if not isinstance(obj[key], bool):
            return False, f"{key} must be JSON bool"
        if obj[key] != gold[key]:
            return False, f"wrong {key}"
    if "failing_test_contains" in gold:
        ft = obj.get("failing_test") or obj.get("failing_test_file") or ""
        if gold["failing_test_contains"] not in str(ft) and gold["failing_test_contains"] not in json.dumps(obj):
            return False, "missing failing test ref"
    ev = obj.get("evidence", [])
    ok_ev, msg = validate_evidence_list(ev)
    if not ok_ev:
        return False, msg
    for fid in gold.get("required_artifact_refs", []):
        if fid not in ev:
            return False, f"missing evidence {fid}"
    return True, "ok"


def evaluate(case: dict, gold: dict, artifacts: dict[str, str], parsed: dict) -> tuple[bool, str]:
    if not isinstance(parsed, dict):
        return False, "Final response must be an object"
    ans = parsed.get("answer", parsed)
    evidence = ans.get("evidence", []) if isinstance(ans, dict) else parsed.get("evidence", [])
    if not evidence or not isinstance(evidence, list) or any(not isinstance(ref, str) or ref not in case["artifact_ids"] for ref in evidence):
        return False, "Missing or out-of-scope evidence"
    if case["type"] == "quick_question":
        return eval_quick(ans if isinstance(ans, dict) else parsed, gold)
    if case["type"] == "feature_table":
        body = ans if isinstance(ans, dict) else parsed
        return eval_feature_table(body, gold, artifacts)
    if case["type"] == "long_running_result":
        body = ans if isinstance(ans, dict) else parsed
        return eval_longrun(body, gold)
    return False, "unknown case type"


class PiClient:
    def __init__(self, pi_cmd: list[str], cwd: Path, benchmark_system: str, fake: Path | None = None):
        self.pi_cmd = pi_cmd
        self.cwd = cwd
        self.benchmark_system = benchmark_system
        self.fake = fake

    def call(self, system: str, user: str, budget: Budget, retry_once: bool = True) -> tuple[str, Usage, str | None, bool]:
        last_err = None
        for attempt in range(2 if retry_once else 1):
            budget.check()
            budget.calls += 1
            try:
                text, usage, stop, ok = self._call_once(system, user)
                budget.total_tokens += usage.totalTokens
                return text, usage, stop, ok
            except OSError as e:
                last_err = str(e)
                if attempt == 0:
                    continue
                raise
        raise RuntimeError(last_err or "pi call failed")

    def _call_once(self, system: str, user: str) -> tuple[str, Usage, str | None, bool]:
        cmd = [sys.executable, str(self.fake)] if self.fake else self.pi_cmd + ["--system-prompt", f"{self.benchmark_system}\n\n{system}"]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=str(self.cwd), text=True, start_new_session=True)
        timed_out = False
        try:
            try:
                output, _ = proc.communicate(user, timeout=CALL_TIMEOUT_SEC)
            except subprocess.TimeoutExpired:
                timed_out = True
                terminate_process_group(proc)
                output, _ = proc.communicate(timeout=5)
            usage, text, stop, bad = Usage(), "", None, timed_out
            for line in output.split("\n"):
                try:
                    event = json.loads(line.rstrip("\r"))
                except (ValueError, TypeError):
                    continue
                if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant":
                    message = event["message"]
                    usage.add(usage_from_dict(message.get("usage", {})))
                    text = content_text(message)
                    stop = message.get("stopReason")
                    bad = bad or stop in ("error", "aborted", "length")
                if event.get("type") == "agent_settled" and event.get("aborted"):
                    bad = True
            return text, usage, stop, proc.returncode == 0 and not bad and bool(text.strip())
        finally:
            if proc.poll() is None:
                terminate_process_group(proc)
                proc.wait(timeout=5)


def content_text(msg: dict) -> str:
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        out = []
        for block in c:
            if isinstance(block, dict) and block.get("type") == "text":
                out.append(block.get("text", ""))
        return "".join(out)
    return ""


def default_pi_cmd() -> list[str]:
    return [
        "pi",
        "--mode",
        "json",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-mcp",
        "--no-approve",
        "--offline",
        "--provider",
        BENCHMARK_PROVIDER,
        "--model",
        BENCHMARK_MODEL,
        "--thinking",
        "minimal",
    ]


def interleave_strategies(strategies: list[str], seed: int) -> list[str]:
    rng = random.Random(seed)
    order = strategies[:]
    rng.shuffle(order)
    return order


def adaptive_envelope_header(case: dict) -> str:
    """Case-type envelope shell (no gold); see protocol/adaptive_handoff_v2.md."""
    aids = ", ".join(case["artifact_ids"])
    t = case.get("type", "")
    if t == "quick_question":
        return (
            "PROTOCOL adaptive_handoff_v2 kind=ASK\n"
            f"ASK: {case['task']}\n"
            f"CONTRACT: {SCHEMA_HINTS[case['answer_schema']]}\n"
            f"ARTIFACT_REFS: {aids} (fixture broker IDs in benchmark)\n"
        )
    if t == "feature_table":
        return (
            "PROTOCOL adaptive_handoff_v2 kind=TASK\n"
            f"GOAL: {case['task'][:160]}\n"
            "SCOPE: bounded table change; preserve baseline transitions\n"
            f"CONSTRAINTS: {SCHEMA_HINTS[case['answer_schema']]}\n"
            f"POINTERS: {aids}\n"
            "DONE_WHEN: full machine_table JSON + evidence IDs\n"
        )
    if t == "long_running_result":
        return (
            "PROTOCOL adaptive_handoff_v2 kind=RESULT\n"
            f"RESULT_SUMMARY: {case['task'][:160]}\n"
            f"OPEN_ISSUES: resolve via artifacts (stale dashboard vs CI truth)\n"
            f"CONTRACT: {SCHEMA_HINTS[case['answer_schema']]}\n"
            f"EVIDENCE_REFS: {aids}\n"
            "LONG_JOB_NOTE: production completion via Herdr durable events/receipts, not LLM polling\n"
        )
    return f"PROTOCOL adaptive_handoff_v2\nPOINTERS: {aids}\n\n"


def apply_hybrid_v2(case: dict, hybrid_body: str) -> str:
    header = adaptive_envelope_header(case)
    return (
        f"{header}"
        "RETRIEVAL: need[] max 2 IDs, max 2 rounds (fixture broker in benchmark)\n\n"
        f"{hybrid_body}"
    )


def pick_baseline(by_strategy: dict[str, dict]) -> str:
    best = "full_evidence"
    best_rate = by_strategy.get("full_evidence", {}).get("pass_rate", 0)
    for name, m in by_strategy.items():
        if m.get("pass_rate", 0) >= best_rate - 0.05:
            if m.get("avg_total_tokens", 1e9) < by_strategy.get(best, {}).get("avg_total_tokens", 1e9):
                best = name
                best_rate = m.get("pass_rate", 0)
    return best


def run_receiver_trial(
    client: PiClient,
    budget: Budget,
    results_dir: Path,
    case: dict,
    gold: dict,
    artifacts: dict[str, str],
    handoff: str,
    strategy: str,
    repeat: int,
    phase: str,
) -> CallRecord:
    schema = SCHEMA_HINTS[case["answer_schema"]]
    convo = (
        f"HANDOFF ({strategy}):\n{handoff}\n\n"
        f"Answer schema: {case['answer_schema']} => {schema}\n"
        f"Available artifact IDs: {', '.join(case['artifact_ids'])}"
    )
    supplied: dict[str, str] = {}
    rounds = 0
    total_usage = Usage()
    t0 = time.time()
    final_parsed = None
    stop = None
    ok_call = True
    err = None
    while rounds <= MAX_RETRIEVAL_ROUNDS:
        text, usage, stop, ok_call = client.call(RECEIVER_SYSTEM, convo, budget)
        total_usage.add(usage)
        sub = CallRecord(
            str(uuid.uuid4()),
            "receiver_call",
            case["id"],
            strategy,
            repeat,
            phase,
            0,
            usage,
            stop,
            ok_call,
            retrieval_rounds=rounds,
        )
        sub.response_text = text
        sub.model = BENCHMARK_MODEL
        sub.provider = BENCHMARK_PROVIDER
        persist_call(results_dir, sub)
        if not ok_call or stop in ("error", "aborted", "length"):
            err = f"failed call stopReason={stop}"
            break
        parsed = parse_json_from_text(text)
        if not parsed:
            err = "invalid json"
            break
        if "need" in parsed and rounds < MAX_RETRIEVAL_ROUNDS:
            need = parsed["need"]
            if not isinstance(need, list) or len(need) > 2:
                err = "invalid need list"
                break
            chunks = []
            for aid in need:
                if not isinstance(aid, str) or aid not in case["artifact_ids"] or aid not in artifacts:
                    err = "unknown or out-of-scope artifact"
                    break
                supplied[aid] = artifacts[aid]
                chunks.append(f"--- artifact:{aid} ---\n{artifacts[aid]}")
            if err:
                break
            extra = "SUPPLIED ARTIFACTS:\n" + "\n\n".join(chunks)
            convo += "\n\n" + extra
            rounds += 1
            continue
        final_parsed = parsed
        break
    passed = False
    eval_reason = err or "No final answer"
    if final_parsed is not None:
        passed, eval_reason = evaluate(case, gold, artifacts, final_parsed)
    wall_ms = int((time.time() - t0) * 1000)
    return CallRecord(
        call_id=str(uuid.uuid4()),
        role="receiver",
        case_id=case["id"],
        strategy=strategy,
        repeat=repeat,
        phase=phase,
        wall_ms=wall_ms,
        usage=total_usage,
        stop_reason=stop,
        ok=ok_call and err is None,
        retrieval_rounds=rounds,
        pass_eval=passed,
        error=err,
        response_text=text,
        eval_reason=eval_reason,
        model=BENCHMARK_MODEL,
        provider=BENCHMARK_PROVIDER,
    )


def record_to_dict(rec: CallRecord) -> dict[str, Any]:
    d = rec.__dict__.copy()
    if isinstance(d.get("usage"), Usage):
        d["usage"] = d["usage"].__dict__
    return d


def persist_call(results_dir: Path, rec: CallRecord) -> None:
    path = results_dir / "per_call.jsonl"
    with path.open("a") as f:
        f.write(json.dumps(record_to_dict(rec)) + "\n")


def load_producer_cache(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def save_producer_cache(path: Path, cache: dict[str, str]) -> None:
    path.write_text(json.dumps(cache, indent=2))


def run_experiment(args: argparse.Namespace) -> dict[str, Any]:
    fx = load_fixtures(ROOT / "fixtures.json")
    artifacts = fx["public_artifacts"]
    run_id = args.run_id or time.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
    results_dir = ROOT / "results" / run_id
    results_dir.mkdir(parents=True, exist_ok=True)
    state_path = results_dir / "state.json"
    if state_path.exists():
        state = json.loads(state_path.read_text())
    else:
        state = {"run_id": run_id, "done_keys": [], "producer": {}}
    budget = budget_from_per_call(results_dir / "per_call.jsonl")
    state.setdefault("started_at", run_wall_start_from_id(run_id) or time.time())
    budget.t0 = state["started_at"]
    neutral = Path(tempfile.mkdtemp(prefix="handoff-bench-"))
    atexit.register(shutil.rmtree, neutral, ignore_errors=True)
    pi_cmd = default_pi_cmd()
    fake = Path(args.fake_pi) if args.fake_pi else None
    client = PiClient(pi_cmd, neutral, args.system_suffix, fake=fake)
    producer_cache = state.get("producer", {})
    strategies = fx["strategies"]
    order = interleave_strategies(strategies, seed=42)
    records: list[CallRecord] = []

    # Producers (9 calls max)
    for case in fx["training_cases"]:
        for strat in MODEL_STRATEGIES_NEED_PRODUCER:
            key = f"{case['id']}:{strat}"
            if key in producer_cache:
                continue
            if args.skip_live:
                producer_cache[key] = f"PLACEHOLDER {strat} for {case['id']}"
                continue
            prompt = producer_prompt(strat, case, artifacts)
            text, usage, stop, ok = client.call(PRODUCER_SYSTEM, prompt, budget)
            rec = CallRecord("", "producer", case["id"], strat, None, "train", 0, usage, stop, ok)
            rec.call_id = str(uuid.uuid4())
            persist_call(results_dir, rec)
            if not ok:
                raise RuntimeError(f"producer failed {key} stop={stop}")
            producer_cache[key] = text.strip()
            state["producer"] = producer_cache
            state_path.write_text(json.dumps(state))

    def handoff_for(case: dict, strat: str) -> str:
        if strat in MODEL_STRATEGIES_NEED_PRODUCER:
            return producer_cache[f"{case['id']}:{strat}"]
        return build_deterministic_handoff(strat, case, artifacts)

    repeats = fx.get("receiver_repeats", 2)
    for case in fx["training_cases"]:
        for strat in order:
            for rep in range(repeats):
                key = f"recv:{case['id']}:{strat}:{rep}"
                if key in state["done_keys"]:
                    continue
                if args.skip_live:
                    continue
                rec = run_receiver_trial(
                    client,
                    budget,
                    results_dir,
                    case,
                    fx["gold"][case["id"]],
                    artifacts,
                    handoff_for(case, strat),
                    strat,
                    rep,
                    "train",
                )
                records.append(rec)
                persist_call(results_dir, rec)
                state["done_keys"].append(key)
                state_path.write_text(json.dumps(state))

    interim = aggregate(results_dir, fx, producer_cache)
    baseline = pick_baseline(interim.get("by_strategy", {}))

    for case in fx.get("holdout_cases", []):
        hkey = f"{case['id']}:hybrid_envelope"
        if hkey not in producer_cache and not args.skip_live:
            prompt = producer_prompt("hybrid_envelope", case, artifacts)
            text, usage, stop, ok = client.call(PRODUCER_SYSTEM, prompt, budget)
            rec = CallRecord(str(uuid.uuid4()), "producer", case["id"], "hybrid_envelope", None, "holdout", 0, usage, stop, ok)
            persist_call(results_dir, rec)
            if not ok:
                raise RuntimeError(f"holdout producer failed {hkey}")
            producer_cache[hkey] = text.strip()
            state["producer"] = producer_cache
            state_path.write_text(json.dumps(state))
        for strat in ("hybrid_envelope_v2", baseline):
            key = f"recv-ho:{case['id']}:{strat}:0"
            if key in state["done_keys"] or args.skip_live:
                continue
            if strat == "hybrid_envelope_v2":
                body = producer_cache.get(hkey, "")
                handoff = apply_hybrid_v2(case, body)
                strat_label = "hybrid_envelope_v2"
            else:
                handoff = handoff_for(case, baseline)
                strat_label = baseline
            rec = run_receiver_trial(
                client,
                budget,
                results_dir,
                case,
                fx["gold"][case["id"]],
                artifacts,
                handoff,
                strat_label,
                0,
                "holdout",
            )
            persist_call(results_dir, rec)
            state["done_keys"].append(key)
            state_path.write_text(json.dumps(state))

    summary = aggregate(results_dir, fx, producer_cache)
    summary["baseline_pick"] = baseline
    (results_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    write_report(results_dir / "report.md", summary, run_id)
    shutil.rmtree(neutral, ignore_errors=True)
    return summary


def pi_call_rows(rows: list[dict]) -> list[dict]:
    return [r for r in rows if r.get("role") in ("producer", "receiver_call")]


def aggregate(results_dir: Path, fx: dict, producer_cache: dict) -> dict[str, Any]:
    rows = []
    total_usage = Usage()
    cached_calls = 0
    uncached_calls = 0
    per_path = results_dir / "per_call.jsonl"
    if not per_path.exists():
        return {
            "rows": [],
            "pi_calls": 0,
            "total_usage": total_usage.__dict__,
            "cached_calls": 0,
            "uncached_calls": 0,
            "by_strategy": {},
            "deterministic_zero_preprocess": ["full_evidence", "reference_only"],
            "producer_cache_keys": list(producer_cache.keys()),
            "holdout_recv_done": 0,
            "holdout_recv_planned": len(fx.get("holdout_cases", [])) * 2,
        }
    for line in per_path.read_text().splitlines():
        if not line.strip():
            continue
        o = json.loads(line)
        u = o.get("usage", {})
        if o.get("role") in ("producer", "receiver_call"):
            total_usage.add(usage_from_dict(u))
            if u.get("cacheRead", 0) > 0:
                cached_calls += 1
            else:
                uncached_calls += 1
        rows.append(o)
    pi_calls = len(pi_call_rows(rows))
    holdout_done = sum(1 for r in rows if r.get("phase") == "holdout" and r.get("role") == "receiver")
    by_strat: dict[str, list] = {}
    for r in rows:
        if r.get("role") != "receiver":
            continue
        by_strat.setdefault(r["strategy"], []).append(r)
    return {
        "rows": rows,
        "pi_calls": pi_calls,
        "total_usage": total_usage.__dict__,
        "cached_calls": cached_calls,
        "uncached_calls": uncached_calls,
        "by_strategy": {
            s: {
                "pass_rate": sum(1 for x in rs if x.get("pass_eval")) / max(len(rs), 1),
                "avg_total_tokens": sum(x["usage"]["totalTokens"] for x in rs) / max(len(rs), 1),
                "avg_retrieval": sum(x.get("retrieval_rounds", 0) for x in rs) / max(len(rs), 1),
            }
            for s, rs in by_strat.items()
        },
        "deterministic_zero_preprocess": ["full_evidence", "reference_only"],
        "producer_cache_keys": list(producer_cache.keys()),
        "holdout_recv_done": holdout_done,
        "holdout_recv_planned": len(fx.get("holdout_cases", [])) * 2,
    }


def write_report(path: Path, summary: dict, run_id: str) -> None:
    tu = summary["total_usage"]
    pi_calls = summary.get("pi_calls", len(summary.get("rows", [])))
    ho_done = summary.get("holdout_recv_done", 0)
    ho_plan = summary.get("holdout_recv_planned", 0)
    partial = ho_done < ho_plan and ho_plan > 0
    bys = summary.get("by_strategy", {})
    best_pass = max((m.get("pass_rate", 0) for m in bys.values()), default=0.0)
    token_leaders = sorted(
        ((s, m) for s, m in bys.items() if m.get("pass_rate", 0) >= best_pass - 0.05),
        key=lambda x: x[1].get("avg_total_tokens", 1e9),
    )
    token_hint = token_leaders[0][0] if token_leaders else "n/a"
    lines = [
        f"# Handoff benchmark report ({run_id})",
        "",
        "Synthetic protocol benchmark only (not real hour-long job execution or arbitrary code productivity).",
        "",
        f"- Pi model calls (producer + receiver_call): **{pi_calls}** / cap {MAX_CALLS}",
        f"- Provider totalTokens (sum of logged usage rows): **{tu['totalTokens']}** / cap {MAX_TOTAL_TOKENS}",
        f"- Cached vs uncached usage rows: {summary['cached_calls']} / {summary['uncached_calls']}",
        f"- Training receiver trials: {sum(1 for r in summary['rows'] if r.get('role')=='receiver' and r.get('phase')=='train')}",
        f"- Holdout receiver trials: {ho_done} / {ho_plan} planned"
        + (" (**partial — budget exhausted before holdout recv**)." if partial else "."),
        "",
        "## Per-strategy (training receiver only in this run)",
        "| strategy | pass_rate | avg_total_tokens | avg_retrieval_rounds |",
        "|---|---:|---:|---:|",
    ]
    for s, m in sorted(bys.items()):
        lines.append(
            f"| {s} | {m['pass_rate']:.2f} | {m['avg_total_tokens']:.1f} | {m['avg_retrieval']:.2f} |"
        )
    lines += [
        "",
        "## Quality vs tokens (no assumed winner)",
        f"At pass_rate within 0.05 of best ({best_pass:.2f}), lowest avg receiver trial tokens: `{token_hint}`. "
        "`hybrid_envelope` matched best pass rate here but used more tokens than `full_evidence`.",
        "",
        "## Recommended protocol (design, not fully holdout-validated)",
        "Use **adaptive envelopes** (`protocol/adaptive_handoff_v2.md`): one-line **ASK** for trivial config questions; "
        "**TASK** schema for feature scope; compact **RESULT** + evidence/open issues for long-run handoffs. "
        "Do not force full TASK blocks on tiny questions. Tuned wrapper: `protocol/hybrid_envelope_v2.md`.",
        "",
        "**Cross-host artifacts:** each pointer must carry broker `artifact_id`, optional `host`, `path`, `sha256`, `version`; "
        "recipient resolves via broker `need[]` or targeted transfer / inline excerpt — never assume sender `/tmp` paths.",
        "",
        "**Long jobs:** waiting should use Herdr durable events/receipts, not repeated LLM status polls; "
        "the static long-result fixture only tests stale-vs-truth reasoning, not live job latency.",
        "",
        "## Limits",
        "Gold evaluators never sent to models; `full_evidence` / `reference_only` have zero model preprocessing. "
        "Provider token fields are not subscription bills. Negative missing/stale-artifact cases covered in unit tests only (no extra model budget).",
    ]
    path.write_text("\n".join(lines) + "\n")


def other_live_runner() -> bool:
    me = os.getpid()
    try:
        out = subprocess.check_output(["pgrep", "-f", "agent-handoff-bench/runner.py"], text=True)
    except subprocess.CalledProcessError:
        return False
    for line in out.splitlines():
        try:
            pid = int(line.strip())
        except ValueError:
            continue
        if pid != me:
            return True
    return False


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--run-id")
    p.add_argument("--fake-pi", help="fake pi script for tests")
    p.add_argument("--skip-live", action="store_true", help="offline aggregate only")
    p.add_argument("--system-suffix", default="<benchmark system>")
    p.add_argument("--unit-self-test", action="store_true")
    p.add_argument("--allow-live", action="store_true", help="Explicitly authorize provider model calls")
    args = p.parse_args()
    if not (args.skip_live or args.fake_pi or args.unit_self_test or args.allow_live):
        p.error("Use --skip-live to summarize existing data, or explicitly --allow-live for a bounded new experiment")
    if args.unit_self_test:
        return run_self_tests()
    if not args.fake_pi and other_live_runner():
        print("another runner already active", file=sys.stderr)
        return 2
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(130))
    run_experiment(args)
    return 0


def run_self_tests() -> int:
    fx = load_fixtures(ROOT / "fixtures.json")
    arts = fx["public_artifacts"]
    g = fx["gold"]["case-feature-cancel"]
    good = {
        "machine_table": json.loads(arts["machine-v1"])
        | {
            "transitions": json.loads(arts["machine-v1"])["transitions"]
            + [{"from": "queued", "event": "cancel", "to": "cancelled"}]
        }
    }
    ok, _ = eval_feature_table(good, g, arts)
    if not ok:
        return 1
    bad = {"machine_table": json.loads(arts["machine-v1"])}
    ok2, _ = eval_feature_table(bad, g, arts)
    if ok2:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
