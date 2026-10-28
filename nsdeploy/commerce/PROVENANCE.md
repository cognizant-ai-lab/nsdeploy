# Commerce arbiter provenance

`arbiter.py` is an unmodified copy of `commerce_demo/arbiter.py` from
https://github.com/babakatwork/agent-commerce-demo at commit
`47fe668ff19c23cf1294685ef122d8ca9fad63e1` (Apache 2.0).
The upstream license and notice are included as `LICENSE.txt` and `UPSTREAM_NOTICE`.

nsdeploy supplies its own `catalog.py`: a single Cailville / Seabreeze Inn fixture,
with stricter one-night, two-adult scope validation. `service.py` provides the
authenticated private-runtime HTTP boundary and a remote seller adapter.
`steward.py` and `middleware.py` integrate the generated Butterpink private network
with nsFlow chat, including a fresh-human-confirmation boundary. The upstream Neuro-SAN
graphs, web server, middleware, and replay model are not copied or executed.
The same upstream capability checks, sealed-bid mechanism, immutable mandates,
offer records, hold expiry, and atomic simulated settlement execute here.
