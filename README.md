# FeatherMark for the web

FeatherMark in a browser, at `app.feathermark.com`. Without logging in it is a demo: the real app with sample notes, where nothing you write is saved and nothing leaves your computer. Logged in, it opens your Feather Cloud notes, decrypted in the browser, and syncs them with the Mac, iPhone and iPad apps.

Work in progress: Phase 17 (foundations) of the plan in [feather-note-universal](https://github.com/raduzoom/feather-note-universal).

## Run it

Needs Node 24 and pnpm, and the `universal` repo checked out beside this one (the tests read its design tokens and crypto test vectors).

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm dev
```

Then open http://localhost:8430. Every check: `bash scripts/test_all.sh`.

## Related repos

- [feathermark-apple](https://github.com/raduzoom/feathermark-apple): the Mac, iPhone and iPad apps (MIT)
- [feather-note-server](https://github.com/raduzoom/feather-note-server): the Feather Cloud server (AGPL-3.0)
- [feather-note-website](https://github.com/raduzoom/feather-note-website): feathermark.com (MIT)
- feather-note-universal (private for now): specs, test vectors, designs and plans (CC BY 4.0)

## License

MIT. See [LICENSE](LICENSE).
