// MUST NOT COMPILE. scripts/check-invariants.sh type-checks this file against the built modules and passes only when the
// compiler refuses each line below with the expected error (ios/README.md, "The invariant"): the only DatabasePool and
// the only URLSession in the app live inside Store and HeadClient, and a main-actor type cannot reach either.

import PBCPClient
import PBCPStore

@MainActor
func reachIn(store: Store, client: HeadClient) async {
  _ = await store.pool // expect: 'pool' is inaccessible due to 'internal' protection level
  _ = await client.session // expect: 'session' is inaccessible due to 'internal' protection level
}
