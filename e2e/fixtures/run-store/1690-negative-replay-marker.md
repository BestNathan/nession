# SC-09 negative Metrics Replay fixture

This is deliberately a **non-main** branch with a different commit SHA.
It is not intended to be merged.

Run the existing read-only **Metrics / Replay Request** workflow by choosing
`test/1690-untrusted-replay-ref` in the GitHub Actions branch selector. The default-main
Metrics / Repository Health workflow's read-only authorization job must
reject the origin before starting any health or Store writer jobs.

This fixture adds no workflow triggers, permissions, actions or secrets.
