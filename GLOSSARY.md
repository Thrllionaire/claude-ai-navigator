# Claude Chat Navigator

A Chrome extension that overlays a navigable outline on a long claude.ai conversation, so the reader can jump to any part of it.

## Language

**Exchange**:
One user question together with Claude's answer to it. The unit the Panel lists and navigates between.
_Avoid_: Turn, message pair, Q&A

**Question**:
The user's message that starts an Exchange.
_Avoid_: Prompt, human turn

**Answer**:
Claude's reply within an Exchange.
_Avoid_: Response, completion

**Panel**:
The overlay on the conversation page that lists the Exchanges.
_Avoid_: Sidebar, overlay, popup

**Item**:
One Exchange's row in the Panel: the Question's first line or sentence (about 80 characters) plus a muted preview of the Answer.
_Avoid_: Title, entry, row

**Jump**:
Clicking an Item to move the view to its Exchange, with the Question aligned to the top of the viewport so the Answer starts right below it.
_Avoid_: Scroll-to, navigate

**Scan**:
The background pass that scrolls through the whole conversation to collect every Exchange, because claude.ai removes off-screen messages from the page.
_Avoid_: Refresh, crawl, load

**Current Exchange**:
The Exchange the reader is currently looking at, highlighted in the Panel as they scroll.
_Avoid_: Active item, scroll-spy target

**Branch**:
One version of the conversation created when a Question is edited or an Answer regenerated. The Panel lists only the Branch currently displayed.
_Avoid_: Fork, version, variant
