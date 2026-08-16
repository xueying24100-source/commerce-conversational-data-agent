# Commerce Data Contract v1

`commerce-data-contract/v1` is the frozen boundary between source-specific ingestion and the diagnostic core. The TypeScript interface is implemented in `src/lib/domains/commerce/agent/source-adapter.ts`; the machine-readable semantic contract is `contract.json`.

The flagship fixture is anchored to the pinned Olist order and item snapshot. Olist has no visits or attribution channel, so the fixture does **not** claim those fields were observed. Daily paid orders and GMV come from the verified public snapshot; visits and drill-down allocation are deterministic demonstration fields generated from seed `20260816`. This is the plan's allowed same-source scenario extension, not a join to an unrelated dataset.

`controlled-commerce-fixture-v1` is a second, independent Adapter fixture used only to prove that Agent Core consumes the stable contract. It represents no real merchant.

Run `npm run generate:commerce-eval` after intentionally changing a generator input. CI uses `npm run check:commerce-eval-assets`, which regenerates in memory, verifies checked-in SHA-256 locks, validates both adapters, and fails on drift. Contract changes that alter required fields, formulas, primary-key semantics, rounding, or safety behavior require a new major contract version.

The fixture and evaluation assets are offline evidence only. They do not establish the Week 10 requirements for 120 real-model runs, Feishu sandbox delivery, browser environments, or external user testing.
