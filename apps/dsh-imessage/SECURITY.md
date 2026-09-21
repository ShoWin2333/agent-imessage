# Security policy

Report suspected credential exposure, authorization bypass, cross-user routing, or Photon resource takeover privately to the package maintainers. Do not include access tokens, project secrets, device codes, message text, or raw phone numbers in a public issue.

The project treats any npm audit finding at **high** or **critical** severity as release-blocking. `better-auth` is pinned to `1.6.30` or newer in this release because the Photon CLI’s older `1.4.18` dependency is affected by unrelated OAuth-provider/server advisories; contract tests verify that the upgraded client still emits Photon’s device-login wire protocol.

As of `0.1.0-alpha.0`, npm reports moderate OpenTelemetry baggage-propagation advisories under Spectrum 12.7’s `@photon-ai/otel` dependency. Spectrum telemetry is explicitly disabled by this plugin, and the vulnerable telemetry packages are not configured as an inbound HTTP baggage processor here. There is no dependency-level fix compatible with the required Spectrum `12.7.x` line yet. Re-evaluate this exception on every Spectrum release and remove it as soon as Photon ships patched OpenTelemetry dependencies.

Security invariants enforced by code and tests include:

- tokens, project secrets, and device codes remain host-only;
- Photon fetches reject cross-origin requests/responses and cross-origin redirects; a single same-origin redirect hop is allowed (for example trailing-slash normalization);
- only the configured sender's inbound iMessage DM route is accepted; dedicated routes verify the exact assigned recipient, while shared routes rely on Photon's project-scoped delivery because Spectrum exposes only its `shared` recipient sentinel;
- authorization failures and unknown internal failures are converted to stable redacted errors;
- approvals and questions are claimed only for an exact correlated iMessage turn and fail closed when delivery is unhealthy;
- disconnect never deletes Photon cloud resources.
