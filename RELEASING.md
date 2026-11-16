# Releasing

A release is a tag. Everything that reaches users goes out from it: the npm package, the GitHub Release and the site on GitHub Pages. Pushing to `main` only runs checks (`ci.yml`).

## Cutting a release

1. Make sure `main` is green.
2. Set the new version in `packages/voxxy/package.json` (for example `0.1.0`), commit it to `main`.
3. Tag that commit and push the tag:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

`release.yml` then:

1. checks that the tag equals the package version and that the commit is on `main`;
2. builds the package and the site, and runs the typecheck and unit tests;
3. publishes the package to npm with provenance;
4. creates the GitHub Release with generated notes and the package tarball attached;
5. deploys the site (landing, examples, API reference) to Pages.

Each step waits for the one before it, so a failed publish leaves no release and no new site.

A tag with a suffix, such as `v0.2.0-rc.1`, is a prerelease: it is published to the npm tag `next`, marked as a prerelease on GitHub, and the site is not touched.

The version shown on the site and in the API reference is read from `packages/voxxy/package.json`, so it changes only when a release is deployed.

## One-time setup

- **npm:** publishing uses trusted publishing (OIDC), so no token is stored. On npmjs.com, in the settings of the `voxxy` package, add a trusted publisher: GitHub Actions, user `t1meshift`, repository `voxxy`, workflow `release.yml`, environment `npm`, with `npm publish` allowed. The first version of a new package has to be published by hand or with a short-lived token, because the setting exists only once the package does. The job runs in the environment `npm`; add required reviewers to that environment if you want a manual approval before each publish.
- **Pages:** Settings, Pages, Source: GitHub Actions.
- **Chat endpoint (optional):** the repository variable `VITE_CHAT_ENDPOINT`, used by the landing's chat.

## If a release fails

A tag that failed before the npm step can be deleted and pushed again after the fix. Once the package is on npm, that version is taken for good: fix forward with the next version.
