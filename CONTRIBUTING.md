# Contributing

Bug reports and pull requests are welcome.

- `npm install`, then `npm test`. The tests stub `fetch` and run on a virtual clock, so they need no network and no API key.
- Keep the runtime dependency count at zero. Devtime is `typescript` and `@types/node`.
- If a change is driven by something the API does, say which endpoint or status code, so the next reader can check it against <https://cleat.so/openapi.json>.
- Never commit a real API key, a webhook signing secret, or a real phone number. Fixtures use obviously fake values such as `clt_test_key_not_a_real_key` and `whsec_test_secret`.
- `npm run typecheck` and `npm run build` should both be clean before you open a pull request.
