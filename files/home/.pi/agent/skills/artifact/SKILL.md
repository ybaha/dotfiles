---
name: artifact
description: Turn the requested answer, analysis, report, plan, or data into a polished standalone HTML artifact with strong visual design, responsive layout, charts, diagrams, and accessible presentation. Use when the user invokes /artifact or asks for an answer as a visual HTML page.
---

# Artifact

Create the answer as a polished, self-contained HTML page rather than returning the full answer in Markdown.

## Workflow

1. Interpret the user's request after the `User:` section below. Do the requested analysis or work normally.
2. Choose a useful visual structure: hero/summary, key metrics, cards, sections, tables, timelines, flow diagrams, charts, or comparison panels as appropriate.
3. Write a complete HTML document to `artifacts/<slug>.html` relative to the current working directory, unless the user specifies another path. Create the directory if needed.
4. Resolve the absolute path, then immediately run `open "<absolute-path>"` with the Bash tool on macOS (or `xdg-open "<absolute-path>"` on Linux). Do not merely tell the user to open it; launch it automatically. If no graphical opener is available, report the absolute file path.
5. Respond in Pi with only a brief confirmation and the file path; the HTML page is the main response.

## Visual quality requirements

- Use semantic HTML and a responsive layout that works on desktop and mobile.
- Include a clear title, subtitle/context, visual hierarchy, and a compact footer with source/date notes when relevant.
- Use a refined color palette, strong typography, generous spacing, cards, borders, gradients, shadows, and hover/focus states; avoid generic unstyled output.
- Prefer inline CSS and inline SVG/CSS graphics so the file works offline and remains portable. Do not invent data: label estimates, assumptions, and illustrative values clearly.
- Use SVG for charts, timelines, architecture diagrams, and flows when useful. Include legends, labels, units, and accessible `<title>`/`<desc>` elements.
- Add print styles, keyboard-visible focus states, sufficient contrast, alt text or accessible labels, and reduced-motion handling.
- For technical content, include readable syntax-highlighted-looking code blocks, callouts, diagrams, and copy buttons only when they add value. Keep code accurate and escape HTML-sensitive characters.
- For comparisons, use a visually scannable table or matrix. For plans, use phases, milestones, owners, and decision points. For data, show the important numbers visually before details.
- Keep dependencies to zero by default. External assets or libraries require an explicit user request and should have a graceful fallback.

## Content rules

- Preserve the substance and nuance of the answer; do not replace meaningful content with decoration.
- State uncertainty, limitations, and provenance directly in the page.
- Do not expose secrets, credentials, private tokens, or sensitive local paths unless the user explicitly requests a safe path reference.
- Use the current date only when a date is relevant; do not imply live data without checking it.
- If the request is ambiguous, make a reasonable assumption and state it in an assumptions section rather than blocking on questions.
- If the user asks for a file at a specific location, follow that location instead of the default.

## Output contract

After creating and opening the page, say:

`Created [title] — <absolute path>`

Mention any important limitation in one additional sentence. Do not paste the entire HTML into the chat unless the user asks for it.

## User request

The text following this section is the user's artifact request. Treat it as the task to complete:
