import json
import tempfile
import time
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import runner

class RegressionTests(unittest.TestCase):
    def test_resume_budget_does_not_count_trial_rollups(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'per_call.jsonl'
            p.write_text('\n'.join(json.dumps(x) for x in [
                {'role':'producer','usage':{'totalTokens':20}},
                {'role':'receiver_call','usage':{'totalTokens':10}},
                {'role':'receiver','usage':{'totalTokens':10}}]))
            b = runner.budget_from_per_call(p)
            self.assertEqual((b.calls,b.total_tokens),(2,30))

    def test_deadline_kills_owned_fake_process(self):
        with tempfile.TemporaryDirectory() as d:
            fake = Path(d)/'hang.py'
            fake.write_text('import time; time.sleep(5)')
            old = runner.CALL_TIMEOUT_SEC
            runner.CALL_TIMEOUT_SEC = 0.05
            start = time.monotonic()
            try:
                _,_,_,ok = runner.PiClient([],Path(d),'unit',fake=fake).call('x','y',runner.Budget())
                self.assertFalse(ok)
                self.assertLess(time.monotonic()-start,3)
            finally:
                runner.CALL_TIMEOUT_SEC=old

    def test_evaluation_rejects_missing_evidence(self):
        fx=runner.load_fixtures(runner.ROOT/'fixtures.json')
        case=fx['training_cases'][0]
        ok,_=runner.evaluate(case,fx['gold'][case['id']],fx['public_artifacts'],{'answer':{'answer':30,'evidence':[]}})
        self.assertFalse(ok)

    def test_long_result_strings_are_not_booleans(self):
        fx=runner.load_fixtures(runner.ROOT/'fixtures.json')
        case=next(c for c in fx['training_cases'] if c['type']=='long_running_result')
        gold=fx['gold'][case['id']]
        answer={'job_id':gold['job_id'],'tests_failed':'false','dashboard_stale':'false','needs_human':'false','agent_idle':'false','evidence':case['artifact_ids']}
        self.assertFalse(runner.evaluate(case,gold,fx['public_artifacts'],{'answer':answer})[0])

if __name__=='__main__': unittest.main()
