# Client version collision evidence

The nationality lane cut local, unpublished 0.73.0 before upstream published
its separate recovery client under the same version. The nationality draft's
exact bytes and original handoff are preserved here; the original handoff's
artifact path is historical and must not be used to select the published client.

The local draft SHA-256 is `bf5c36323dcc9b4416e82580fa45f29132be944bb5789fd874b06694eb10f3d8`.
The published origin/main 0.73.0 SHA-256 is `26f0d0135399b2a8627d48a529ef49e76e91282d555e33166f65d19acb85e1b9`, from
`e9d6e6c7495bb2b5e257c4e5cd3508d134c1c8aa`. The published release identity will
be retained during integration. Neither artifact is relabeled as the other.
The combined contract is reserved as 0.79.0, to be generated and validated after
integration and adopted by the owned Solid consumer before release.

This directory is preservation evidence, not an installable release selection.
The ledger and current package artifact remain the release authority. No push,
deployment or feature enablement occurred in making this capture.
