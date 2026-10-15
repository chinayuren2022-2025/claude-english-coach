# English Coach for Claude Code

Practise English by working with Claude in English only. Made for Chinese-speaking learners (for example, aiming for IELTS 7.5).

在 Claude Code 里只用英语和 Claude 交流，练英语。为中文母语的学习者设计。

## What it does

- **Claude replies in English.** Its system prompt gets only a few light lines, so no learner rules shape how it thinks or writes. After each reply, Haiku picks the hard words and the mod adds a short Chinese gloss to what you see: `idempotent（幂等的）`. Claude's stored reply, which it reads back later, stays exactly as it wrote it. Code, links and URLs are never glossed.
- **Your level is measured automatically** from what you write (CEFR A2–C1), and shown as a slider under the prompt, with your goal marked: `EN A1─A2─[B1]─B2─C1★─C2`.
- **Check before you send.** When you press Enter, your English is checked first, with Claude's last reply as context, so "you" and "I" keep their meaning. Only real errors are fixed, with the smallest edit; style ideas go to "Level up". If it can be better, the message stays in the box and a card shows above the prompt: your sentence with the mistakes struck out in red and the fixes in green, and short numbered tips in Chinese. Fix it yourself, press `Use suggestion` (`u`), or press Enter again to send it as is.
- **Level up.** Even when your English is natural, you get one stronger word or phrase toward your goal: `fix this bug → track down this bug`.
- **Write in Chinese when you're stuck.** Chinese or mixed input becomes an English draft in the box for you to check, with the key phrases shown: `优化 → optimize`. Start a prompt with `zh:` to send Chinese as typed.

The checks, drafts and glosses use a small, fast model (Haiku): one call per message you send, and one per reply block Claude writes (at most 6 per turn).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install english-coach --marketplace chinayuren2022-2025/claude-english-coach
```

Answer `y` to add the marketplace, then choose a scope (user scope loads it in every session).

From a shell:

```
claude plugin install english-coach --marketplace chinayuren2022-2025/claude-english-coach
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `chinayuren2022-2025/claude-english-coach`, then **Add plugin**.

## Commands

| Command | What it does |
| --- | --- |
| `/english` | Show settings and help |
| `/english on` / `off` | Turn the mode on or off |
| `/english level auto` | Measure your level from your writing (default) |
| `/english level A2\|B1\|B2\|C1` | Fix the level of Claude's English |
| `/english goal IELTS 7.5` | Set your target |
| `/english gloss on\|off` | Chinese glosses after hard words |
| `/english feedback before\|after\|off` | Check before sending (default), feedback after sending, or none |
| `/english chinese review\|auto\|off` | Chinese input: draft to check (default), translate and send, or send as typed |
| `/english demo` | Show a sample feedback card |
| `/en <text>` | Turn Chinese or rough English into an English draft in the box |

Settings are kept across sessions.

## Notes

- Where an organization manages Claude Code, the English-only system prompt part does not run for plugins a person installs; the input help still works.
- Develop: `claude --plugin-dir .` loads it from this folder; `claude plugin test .` runs the tests.

## License

MIT
