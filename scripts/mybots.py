#!/usr/bin/env python3
"""
List every Telegram bot YOUR account owns, by asking @BotFather.

Telegram's Bot API cannot do this: it answers per-token (getMe) and has no
"list my bots" call. The only complete list is BotFather's /mybots, and
BotFather is a chat bot — so reading it means acting as YOU, over MTProto.

    RUN THIS ON YOUR OWN MACHINE, NOT ON THE HATCHABOT SERVER.

It signs in as your Telegram user. The session file it creates is a full
credential for your account — anyone holding it can read your chats and act as
you. That is a far bigger secret than any bot token, which is exactly why
Hatchabot itself never does this and has no way to. Keep the session off the
server, and delete it when you are done (this script offers to).

    pip install telethon
    python3 scripts/mybots.py                 # prompts for API id/hash + login
    python3 scripts/mybots.py --keep-session  # don't delete the session after

Get api_id / api_hash once at https://my.telegram.org → API development tools.
They identify the *app*, not you; the phone login is what authenticates you.

Output is one handle per line — paste it into Hatchabot:
Settings → Telegram bots → the census → "Compare with BotFather's list",
which tells you which of them this server knows nothing about.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import tempfile
from pathlib import Path

try:
    from telethon import TelegramClient
except ImportError:  # pragma: no cover - a user-run script
    sys.exit("telethon is not installed:  pip install telethon")

BOTFATHER = "@BotFather"
# BotFather paginates /mybots once you have more than a screenful.
NEXT_PAGE = ("»", "Next", ">>")
MAX_PAGES = 20


def handles(message) -> list[str]:
    """Every @handle on this message's inline keyboard, in order."""
    out: list[str] = []
    for row in (message.buttons or []):
        for button in row:
            text = (button.text or "").strip()
            # Buttons read "@somebot" (sometimes "@somebot - Name").
            if text.startswith("@"):
                out.append(text.split()[0].lstrip("@"))
    return out


async def collect(client) -> list[str]:
    # Send, then WAIT for BotFather's answer: reading "the last message" straight
    # after sending usually returns your own /mybots, not the reply.
    async with client.conversation(BOTFATHER, timeout=30) as chat:
        await chat.send_message("/mybots")
        reply = await chat.get_response()

    found: list[str] = []
    seen: set[str] = set()
    for _ in range(MAX_PAGES):
        for handle in handles(reply):
            if handle.lower() not in seen:
                seen.add(handle.lower())
                found.append(handle)
        nxt = next(
            (
                (r, c)
                for r, row in enumerate(reply.buttons or [])
                for c, b in enumerate(row)
                if (b.text or "").strip() in NEXT_PAGE
            ),
            None,
        )
        if not nxt:
            break
        await reply.click(*nxt)          # BotFather edits the same message
        await asyncio.sleep(1.5)
        reply = (await client.get_messages(BOTFATHER, ids=reply.id))
        if reply is None:
            break
    return found


async def main() -> int:
    ap = argparse.ArgumentParser(description="List the bots your Telegram account owns.")
    ap.add_argument("--keep-session", action="store_true", help="keep the login session file (it is a credential)")
    ap.add_argument("--session", help="where to keep the session (default: a temp file, deleted at the end)")
    args = ap.parse_args()

    api_id = os.environ.get("TELEGRAM_API_ID") or input("api_id (my.telegram.org): ").strip()
    api_hash = os.environ.get("TELEGRAM_API_HASH") or input("api_hash: ").strip()
    if not api_id.isdigit():
        return print("api_id is a number.", file=sys.stderr) or 2

    session = Path(args.session) if args.session else Path(tempfile.mkdtemp(prefix="mybots-")) / "session"
    client = TelegramClient(str(session), int(api_id), api_hash)
    try:
        await client.start()             # asks for your phone, the code, and 2FA if set
        names = await collect(client)
    finally:
        await client.disconnect()
        if not args.keep_session and not args.session:
            for leftover in session.parent.glob("session*"):
                leftover.unlink(missing_ok=True)
            session.parent.rmdir()

    print("\n".join(names))
    print(f"\n{len(names)} bot(s). Telegram allows about 20 per account.", file=sys.stderr)
    if args.keep_session or args.session:
        print(f"The session at {session} logs in as you — delete it when done.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
