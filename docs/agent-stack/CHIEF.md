# Chief of staff — disabled pending an hc port

The owner no longer runs a Chief session. Do not start `pi-chief`, its Telegram worker, or a Chief workspace. There is no standing UI exception for Chief/Telegram.

The retained implementation in `files/home/.pi/agent/chief-of-staff/` targets the old Herdr TUI API and has **not** been ported. Its Pi startup wrapper is inert when `HC_TERMINAL_ID` is set, `HERDR_ENV` is unset/not `1`, or `herdr` is absent. It does not load SQLite/Telegram code or register tools/timers in those environments. The CLI has the same runtime gate. Legacy logic remains for isolated tests and reference, not an hc workflow.

Do not remove local memories, databases or credentials during this migration. Existing state stays in `~/.local/share/pi-chief/`; private configuration and Telegram credentials stay under `~/.config/pi-chief/`. Nothing is synced or printed.

Any future hc port, replacement Telegram integration or deletion of retained state requires a separate owner decision. Current terminal and delegation guidance: [HC.md](HC.md), [SUBAGENTS.md](SUBAGENTS.md), [ROUTING.md](ROUTING.md).
