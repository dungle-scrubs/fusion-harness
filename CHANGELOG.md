# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **patterns:** six tool-owned problem-solving runs - jury, red-blue, ach, delphi, shortlist, gonogo - each with sealed workers through `hcn`, schema validation at the boundary, tool-stamped provenance, and a mechanical fuse
- **cli:** tier-1 pure functions (validate, normalize, aggregate, score), model-free and deterministic
- **cli:** `fusion skill` emits the complete caller guide, including per-method selection rules with counter-rules
- **engine:** staged waves with anonymized handoff, run-scoped claim ids, one retry with validator errors fed back, replayable event streams, and durable per-invocation command records
- **errors:** envelope contract with E-codes and exit classes (0 ok, 1 usage, 2 validation/gate, 3 nothing takeable, 4 internal); crashes surface as E499 envelopes, never as usage errors
