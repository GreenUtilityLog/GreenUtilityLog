# VeWorld / VeChain AppHub listing

`io.github.greenutilitylog/` is our entry for [vechain/app-hub](https://github.com/vechain/app-hub),
which puts the app in VeWorld's Discover tab. It passes that repo's own
`scripts/validate.ts` (manifest fields, 512×512 PNG logo).

**Not submitted yet — AppHub rule 1: "The app must run on Mainnet".** We run on testnet.

When we are on mainnet:

1. Check `veBetterDaoId`. It is `keccak256("Green Utility Log")`, the id our testnet
   app has. A mainnet app registered under exactly that name gets the same id; any
   other name gives a different one (take it from the governance app URL).
2. Fork vechain/app-hub, copy `io.github.greenutilitylog/` into its `apps/` folder,
   and open one pull request with only that folder.
