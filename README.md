# FeatherMark for the web

FeatherMark in a browser, at `app.feathermark.com`. Without logging in it is a demo: the real app with sample notes, where nothing you write is saved and nothing leaves your computer. Logged in, it opens your Feather Cloud notes, decrypted in the browser, and syncs them with the Mac, iPhone and iPad apps.

The demo has the library, search and a live-preview Markdown editor with the block menu and attachments (Phases 17–19 of the plan in feather-note-universal). Accounts and sync come in Phase 20.

## Run it

Needs Node 24 and pnpm. The tests also need the `universal` repo checked out beside this one (they read its design tokens, crypto test vectors and editor fixtures); `pnpm build` doesn't.

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
