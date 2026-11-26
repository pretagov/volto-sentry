# volto-sentry

## Features

A Volto add-on that provides [Sentry.io](https://sentry.io/welcome/) integration.

## Prerequisites
  
  1. In Sentry create a new organization, and add a project to it.
  2. Create an API Token: on the top left corner, click on your name -> API keys and create a new token, "project:write" scope should be selected.

## Buildtime and Runtime
The configuration is done using environment variables:

  * `SENTRY_DSN` - required to enable the feature
  * `SENTRY_URL` - the URL of Sentry
  * `SENTRY_AUTH_TOKEN` - the authentication token for Sentry
  * `SENTRY_ORG` - the name of the organization in Sentry
  * `SENTRY_PROJECT` -the name of the project in Sentry
  * `SENTRY_RELEASE` - release number
  
If these environment variables are configured, when the app is built or starts locally, a new release will be created in Sentry.
The source code and source maps will be uploaded to Sentry, too.
After starting the application, if an error occurs, the errors will be sent to Sentry, and will be linked to the specified release.

## Event limits

A fault that repeats on every request or render, or in a loop, can send thousands of events a
minute and use up a month's Sentry quota. The SSR server process, and each page in the browser,
therefore sends at most:

  * `RAZZLE_SENTRY_MAX_EVENTS_PER_HOUR` error events an hour (default `60`), with up to
    `RAZZLE_SENTRY_MAX_EVENTS_BURST` at once (default `20`);
  * `RAZZLE_SENTRY_MAX_EVENTS_PER_ERROR` events an hour for any one error (default `10`). An
    error is the exception type and the line that threw it, or the message.

The counts refill continuously, so after a burst events flow again at the hourly rate. `0` turns a
limit off; set both `RAZZLE_SENTRY_MAX_EVENTS_PER_HOUR` and `RAZZLE_SENTRY_MAX_EVENTS_PER_ERROR`
to `0` to send everything. The variables are read at runtime, on the server from `process.env`
and in the browser from `window.env`. A malformed value falls back to the default with a console
warning. Your own `beforeSend` (from `settings.sentryOptions`) runs first, so the events it drops
don't count. Transactions are not limited.

## Upgrade

### 2.0.0

Developed and tested against `@plone/volto` 19 (React 18). The add-on API is unchanged: the
`sentryOptions` callback and the SSR helpers (`withSentrySSRErrorHandling`,
`sentrySSRErrorMiddleware`, `captureSSRError`) keep their signatures, so an upgrade needs no code
changes.

- the repository became a pnpm monorepo and the add-on moved to `packages/volto-sentry`, so the
  development workflow is `pnpm install`, `pnpm start`, `pnpm test` and `pnpm build`;
- the Yarn and npm lock files were replaced by `pnpm-lock.yaml` and `pnpm-workspace.yaml`
  (`packageManager: pnpm@10.20.0`).

### 1.x

This version requires `@plone/volto >= 16.0.0.alpha.45` (`sentry` removed from Volto Core).

## Installing the addon

1. If you already have a Volto project, update `package.json`:

   ```json
   "addons": [
      "@plone-collective/volto-sentry"
   ],

   "dependencies": {
      "@plone-collective/volto-sentry": "*"
   }
   ```

1. If not, create one:

   ```
   npm install -g yo @plone/generator-volto
   yo @plone/volto my-volto-project --addon @plone-collective/volto-sentry
   cd my-volto-project
   ```


1. Install new add-ons and restart Volto:

   ```
   yarn
   yarn start
   ```

1. Go to http://localhost:3000

1. Happy editing!
