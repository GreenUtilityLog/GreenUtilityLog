# Server messages in more languages

One file per language, `<code>.js` (two letters, as the app sends it in `X-GUL-Lang`):

```js
export default {
  "invalid wallet address": "…",
  // every English text from MESSAGES in ../messages.js, with its {placeholders} kept
};
```

The server reads every file here at start. `test/messages.test.js` checks that a
file has every message and keeps the placeholders. A message a file doesn't have
yet is sent in English. The app's own texts for that language are in
`src/lang/<code>.js`.
