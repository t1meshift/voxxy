# voxxy

In-browser speech-to-text and text-to-speech. All inference runs on the device, with no server involved. Version 0.x: the API is not stable yet.

- No UI in the library. The host owns the consent popup, texts and styles.
- Weights are not bundled. They download in the background after the user opts in, STT and TTS separately, with sizes shown.
- Push-to-talk, one thread, no COOP/COEP headers needed.
- Adapters are separate entry points, so unused models are not pulled in. Today: Moonshine tiny (STT, English), Paradee (TTS, English) and a browser-speech fallback.

The API, providers, storage and measurements are described in [packages/voxxy/README.md](packages/voxxy/README.md).

## Repository

| Path | What |
|---|---|
| `packages/voxxy` | the library |
| `apps/landing` | public page and live demo (published to GitHub Pages) |
| `apps/stand` | test stand, also used to measure on real phones |
| `e2e` | Playwright tests |

## Development

Node 22 or newer and pnpm.

```bash
pnpm install
pnpm dev            # the stand
pnpm test           # unit tests
pnpm typecheck
pnpm test:e2e       # needs a browser, see TESTING.md
```

[TESTING.md](TESTING.md) covers the e2e suite, including the real-model run (`pnpm test:e2e:models`, about 47 MB of downloads).

## Releases

A release is a version tag: it publishes the package to npm, creates the GitHub Release and deploys the site. Pushes to `main` only run checks. See [RELEASING.md](RELEASING.md).

## Licence

Apache-2.0, see [LICENSE](LICENSE). Third-party models and data are credited in [packages/voxxy/NOTICE](packages/voxxy/NOTICE); their licences are summarised in the Licences section of the package README. The misaki dictionaries have no documented provenance.
