# Dictation benchmark: synthetic, none-raw

- Model: `whisper-base.en-51eefc0` (q8), @huggingface/transformers in Node on onnxruntime-node 1.30.0 (cpu). The browser runs the same files on WASM, so numerics can differ slightly and a clip or two may score differently.
- Prompt: `none`, 0 tokens
- Audio: raw; beams: 1; max_new_tokens: 96
- 60 clips, 0.26 s per clip (model load 0.3 s), 2026-10-31

| Amount usable | Strict | Merchant | Date | Keep |
| --- | --- | --- | --- | --- |
| 42/60 | 39/60 | 33/42 | 15/15 | 24/27 |

Per voice, amount usable: Samantha 16/20, Daniel 13/20, Karen 13/20. Strict: Samantha 15/20, Daniel 12/20, Karen 12/20. Merchant: Samantha 12/14, Daniel 11/14, Karen 10/14.

Prompt words copied into a transcript that the phrase did not contain: 0 clip(s).

Misses:

- amount: Samantha-02.wav → `over 2340.`; Samantha-09.wav → `Netflix 1699`; Samantha-13.wav → `Shoppers Drug Mart 1249 today.`; Samantha-16.wav → `Spent 950 on bubble tea yesterday.`; Daniel-02.wav → `UBER 2340`; Daniel-05.wav → `Coffee at Tim Hortons 475.`; Daniel-09.wav → `Netflix 1699.`; Daniel-13.wav → `Shoppers drug mark 1249 today.`; Daniel-16.wav → `Spent 950 on bubble tea yesterday.`; Daniel-17.wav → `Amazon Order 4217`; Daniel-20.wav → `Refund from Best by 1899.`; Karen-02.wav → `Uber 2340`; Karen-09.wav → `Netflix 1699`; Karen-13.wav → `Shop is drug mark 1249 today.`; Karen-15.wav → `Gas at Petro Canada 5130`; Karen-16.wav → `Spent 950 on bubble tea yesterday.`; Karen-19.wav → `Movie tickets at Cineplex 3250.`; Karen-20.wav → `Refund from Best by 1899-99.`
- strict only: Samantha-03.wav → `Groceries at No Freel 62 18 yesterday`; Daniel-03.wav → `Groceries at no frills 62-18 yesterday.`; Karen-03.wav → `groceries at No Freels 62 18 yesterday`
- merchant: Samantha-02.wav → `over 2340.`; Samantha-03.wav → `Groceries at No Freel 62 18 yesterday`; Daniel-10.wav → `dinner at the CEG $84.20 last night.`; Daniel-13.wav → `Shoppers drug mark 1249 today.`; Daniel-20.wav → `Refund from Best by 1899.`; Karen-03.wav → `groceries at No Freels 62 18 yesterday`; Karen-10.wav → `dinner at the Kegg $84.20 last night.`; Karen-13.wav → `Shop is drug mark 1249 today.`; Karen-20.wav → `Refund from Best by 1899-99.`
- keep: Samantha-01.wav → `Launch $15.`; Samantha-14.wav → `$25 on Steam.`; Karen-14.wav → `$25 on steam`

| Voice | Id | Amount | Strict | Merchant | Date | Keep | s | Transcript |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Samantha | 01 | yes | yes | – | – | **no** | 0.28 | `Launch $15.` |
| Samantha | 02 | **no** | **no** | **no** | – | – | 0.24 | `over 2340.` |
| Samantha | 03 | yes | **no** | **no** | yes | – | 0.27 | `Groceries at No Freel 62 18 yesterday` |
| Samantha | 04 | yes | yes | – | – | yes | 0.28 | `paid rent $1,150.` |
| Samantha | 05 | yes | yes | yes | – | – | 0.28 | `Coffee at Tim Hortons 4.75.` |
| Samantha | 06 | yes | yes | – | yes | yes | 0.26 | `Bus Pass 128 yesterday.` |
| Samantha | 07 | yes | yes | yes | – | yes | 0.3 | `got paid 2,480 from my co-op.` |
| Samantha | 08 | yes | yes | yes | – | yes | 0.26 | `Text book from the bookstore 99.99` |
| Samantha | 09 | **no** | **no** | yes | – | – | 0.23 | `Netflix 1699` |
| Samantha | 10 | yes | yes | yes | yes | – | 0.29 | `dinner at the KEG $84.20 last night.` |
| Samantha | 11 | yes | yes | – | – | yes | 0.24 | `haircut $35.` |
| Samantha | 12 | yes | yes | – | – | yes | 0.25 | `Phone bill $65.` |
| Samantha | 13 | **no** | **no** | yes | yes | – | 0.26 | `Shoppers Drug Mart 1249 today.` |
| Samantha | 14 | yes | yes | yes | – | **no** | 0.25 | `$25 on Steam.` |
| Samantha | 15 | yes | yes | yes | – | – | 0.26 | `Gasset Petro, Canada 51.30` |
| Samantha | 16 | **no** | **no** | yes | yes | – | 0.26 | `Spent 950 on bubble tea yesterday.` |
| Samantha | 17 | yes | yes | yes | – | – | 0.25 | `Amazon Order 42.17` |
| Samantha | 18 | yes | yes | – | – | yes | 0.25 | `tuition deposit $500.` |
| Samantha | 19 | yes | yes | yes | – | – | 0.26 | `Movie tickets at Cineplex 32.50` |
| Samantha | 20 | yes | yes | yes | – | – | 0.26 | `Refund from Best Buy 89.99` |
| Daniel | 01 | yes | yes | – | – | yes | 0.25 | `Lunch $15.` |
| Daniel | 02 | **no** | **no** | yes | – | – | 0.24 | `UBER 2340` |
| Daniel | 03 | yes | **no** | yes | yes | – | 0.28 | `Groceries at no frills 62-18 yesterday.` |
| Daniel | 04 | yes | yes | – | – | yes | 0.26 | `Paid rent $1,150.` |
| Daniel | 05 | **no** | **no** | yes | – | – | 0.28 | `Coffee at Tim Hortons 475.` |
| Daniel | 06 | yes | yes | – | yes | yes | 0.26 | `Bus Pass 128 yesterday.` |
| Daniel | 07 | yes | yes | yes | – | yes | 0.3 | `God paid 2,480 from my co-op.` |
| Daniel | 08 | yes | yes | yes | – | yes | 0.27 | `textbook from the bookstore 99.99.` |
| Daniel | 09 | **no** | **no** | yes | – | – | 0.24 | `Netflix 1699.` |
| Daniel | 10 | yes | yes | **no** | yes | – | 0.28 | `dinner at the CEG $84.20 last night.` |
| Daniel | 11 | yes | yes | – | – | yes | 0.25 | `Haircut $35.` |
| Daniel | 12 | yes | yes | – | – | yes | 0.25 | `Phone Bill $65.` |
| Daniel | 13 | **no** | **no** | **no** | yes | – | 0.26 | `Shoppers drug mark 1249 today.` |
| Daniel | 14 | yes | yes | yes | – | yes | 0.26 | `Twenty-five US dollars on steam.` |
| Daniel | 15 | yes | yes | yes | – | – | 0.26 | `Gas at Petro Canada 51.30.` |
| Daniel | 16 | **no** | **no** | yes | yes | – | 0.26 | `Spent 950 on bubble tea yesterday.` |
| Daniel | 17 | **no** | **no** | yes | – | – | 0.24 | `Amazon Order 4217` |
| Daniel | 18 | yes | yes | – | – | yes | 0.24 | `tuition deposit $500.` |
| Daniel | 19 | yes | yes | yes | – | – | 0.27 | `Movie tickets at Cineplex 32.50` |
| Daniel | 20 | **no** | **no** | **no** | – | – | 0.25 | `Refund from Best by 1899.` |
| Karen | 01 | yes | yes | – | – | yes | 0.24 | `Lunch $15.` |
| Karen | 02 | **no** | **no** | yes | – | – | 0.23 | `Uber 2340` |
| Karen | 03 | yes | **no** | **no** | yes | – | 0.26 | `groceries at No Freels 62 18 yesterday` |
| Karen | 04 | yes | yes | – | – | yes | 0.26 | `paid rent $1,150.` |
| Karen | 05 | yes | yes | yes | – | – | 0.27 | `Coffee at Tim Hortons 4.75` |
| Karen | 06 | yes | yes | – | yes | yes | 0.24 | `Bus Pass 128 yesterday` |
| Karen | 07 | yes | yes | yes | – | yes | 0.28 | `got paid 2,480 from my co-op.` |
| Karen | 08 | yes | yes | yes | – | yes | 0.26 | `textbook from the bookstore 99.99.` |
| Karen | 09 | **no** | **no** | yes | – | – | 0.23 | `Netflix 1699` |
| Karen | 10 | yes | yes | **no** | yes | – | 0.27 | `dinner at the Kegg $84.20 last night.` |
| Karen | 11 | yes | yes | – | – | yes | 0.25 | `haircut $35.` |
| Karen | 12 | yes | yes | – | – | yes | 0.24 | `Phone bill $65.` |
| Karen | 13 | **no** | **no** | **no** | yes | – | 0.26 | `Shop is drug mark 1249 today.` |
| Karen | 14 | yes | yes | yes | – | **no** | 0.24 | `$25 on steam` |
| Karen | 15 | **no** | **no** | yes | – | – | 0.26 | `Gas at Petro Canada 5130` |
| Karen | 16 | **no** | **no** | yes | yes | – | 0.26 | `Spent 950 on bubble tea yesterday.` |
| Karen | 17 | yes | yes | yes | – | – | 0.25 | `Amazon Order 42.17` |
| Karen | 18 | yes | yes | – | – | yes | 0.25 | `tuition deposit $500.` |
| Karen | 19 | **no** | **no** | yes | – | – | 0.31 | `Movie tickets at Cineplex 3250.` |
| Karen | 20 | **no** | **no** | **no** | – | – | 0.28 | `Refund from Best by 1899-99.` |
