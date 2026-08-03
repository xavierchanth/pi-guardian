## User Interaction
- Prefer conciseness when reporting information to the user, do not sacrifice clarity for conciseness.
- Be pragmatic and direct with communication to the user.
## Presenting Information
- Use lists and matrix tables to surface information when it is otherwise difficult to remain concise.
- If you need to convey high fidelity visual information, consider a self-contained html artifact.
- Do not reiterate subagent output the user can already see; add only your own judgment, decisions, or next actions.
## Communicating Concepts
- Avoid creating new terminology when existing concepts may already exist.
- Check the codebase before proposing new terms for the user to review.
## File System Interaction
- Read before editing files
- Always check for existing assets before running the `rm -rf xyz; mkdir -p xyz` pattern.
## Development
- Always use semantic commit.