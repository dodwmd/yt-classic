# Security policy

YouTube Classic is a **personal, self-hosted project** with no login. It is meant to run on a network you trust.
Do not expose it to the internet (see the README).

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** (GitHub private vulnerability reporting).

Include what you found, how to reproduce it, and which version or commit you tested. This is a spare-time
project, so there is no response-time guarantee, but reports are read and taken seriously.

## Supported versions

Only the latest commit on `main` is supported. There are no release branches.

## What is in scope

- Code in this repository: the backend, the frontend assets, the Containerfiles and the compose file.
- Problems such as injection, request forgery, resource exhaustion, secret leakage, or unsafe container defaults.

## What is out of scope

- Running the app exposed to the public internet without your own authentication in front of it. It has none
  by design.
- Vulnerabilities in YouTube, yt-dlp, ffmpeg, nginx or Node.js themselves; report those upstream.
- Using this project to access content in ways that break YouTube's Terms of Service.
