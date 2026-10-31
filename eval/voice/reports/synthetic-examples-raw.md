# Dictation benchmark: synthetic, examples-raw

- Model: `whisper-base.en-51eefc0` (q8), @huggingface/transformers in Node on onnxruntime-node 1.30.0 (cpu). The browser runs the same files on WASM, so numerics can differ slightly and a clip or two may score differently.
- Prompt: `examples`, 23 tokens:

  `pizza at dominos eighteen twenty five parking seven fifty yesterday paid twelve hundred rent sobeys forty three oh six today`
- Audio: raw; beams: 1; max_new_tokens: 96
- 60 clips, 0.27 s per clip (model load 0.4 s), 2026-10-31

| Amount usable | Strict | Merchant | Date | Keep |
| --- | --- | --- | --- | --- |
| 56/60 | 54/60 | 34/42 | 15/15 | 27/27 |

Per voice, amount usable: Samantha 18/20, Daniel 20/20, Karen 18/20. Strict: Samantha 17/20, Daniel 20/20, Karen 17/20. Merchant: Samantha 12/14, Daniel 9/14, Karen 13/14.

Prompt words copied into a transcript that the phrase did not contain: 0 clip(s).

Misses:

- amount: Samantha-02.wav → `uber 2340`; Samantha-09.wav → `netflix 1699`; Karen-02.wav → `uber 2340`; Karen-20.wav → `refund from Best Buy 1899.`
- strict only: Samantha-17.wav → `Amazon Order 42 17`; Karen-17.wav → `amazon order 42 17`
- merchant: Samantha-03.wav → `groceries at no frail sixty two eighteen yesterday`; Samantha-13.wav → `shoppers drug mark twelve forty nine today`; Daniel-02.wav → `you but twenty three forty`; Daniel-07.wav → `god paid two thousand four hundred eighty from michael art`; Daniel-13.wav → `shoppers drug mark twelve forty nine today`; Daniel-19.wav → `movie tickets at synaplex thirty two fifty`; Daniel-20.wav → `refund from best by eighty nine ninety nine`; Karen-13.wav → `shoppers drugmark twelve forty nine today`

| Voice | Id | Amount | Strict | Merchant | Date | Keep | s | Transcript |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Samantha | 01 | yes | yes | – | – | yes | 0.33 | `lunch fifteen dollars` |
| Samantha | 02 | **no** | **no** | yes | – | – | 0.27 | `uber 2340` |
| Samantha | 03 | yes | yes | **no** | yes | – | 0.27 | `groceries at no frail sixty two eighteen yesterday` |
| Samantha | 04 | yes | yes | – | – | yes | 0.27 | `paid rent one thousand one hundred fifty dollars` |
| Samantha | 05 | yes | yes | yes | – | – | 0.28 | `coffee at tim horton's four seventy five` |
| Samantha | 06 | yes | yes | – | yes | yes | 0.26 | `bus pass one twenty eight yesterday` |
| Samantha | 07 | yes | yes | yes | – | yes | 0.3 | `got paid two thousand four hundred eighty from my co-op` |
| Samantha | 08 | yes | yes | yes | – | yes | 0.31 | `text book from the bookstore ninety nine ninety nine` |
| Samantha | 09 | **no** | **no** | yes | – | – | 0.25 | `netflix 1699` |
| Samantha | 10 | yes | yes | yes | yes | – | 0.31 | `dinner at the keg eighty four dollars and twenty cents last night` |
| Samantha | 11 | yes | yes | – | – | yes | 0.26 | `haircut thirty five dollars` |
| Samantha | 12 | yes | yes | – | – | yes | 0.25 | `phone bill sixty five dollars` |
| Samantha | 13 | yes | yes | **no** | yes | – | 0.26 | `shoppers drug mark twelve forty nine today` |
| Samantha | 14 | yes | yes | yes | – | yes | 0.26 | `twenty five us dollars on steam` |
| Samantha | 15 | yes | yes | yes | – | – | 0.32 | `gasset petro canada fifty one thirty` |
| Samantha | 16 | yes | yes | yes | yes | – | 0.28 | `spent nine fifty on bubble tea yesterday` |
| Samantha | 17 | yes | **no** | yes | – | – | 0.25 | `Amazon Order 42 17` |
| Samantha | 18 | yes | yes | – | – | yes | 0.26 | `tuition deposit five hundred dollars` |
| Samantha | 19 | yes | yes | yes | – | – | 0.27 | `movie tickets at cineplex thirty two fifty` |
| Samantha | 20 | yes | yes | yes | – | – | 0.26 | `refund from Best Buy 89.99` |
| Daniel | 01 | yes | yes | – | – | yes | 0.24 | `lunch fifteen dollars` |
| Daniel | 02 | yes | yes | **no** | – | – | 0.26 | `you but twenty three forty` |
| Daniel | 03 | yes | yes | yes | yes | – | 0.27 | `groceries at no frills sixty two eighteen yesterday` |
| Daniel | 04 | yes | yes | – | – | yes | 0.27 | `paid rent one thousand one hundred fifty dollars` |
| Daniel | 05 | yes | yes | yes | – | – | 0.27 | `coffee at tim hortons four seventy five` |
| Daniel | 06 | yes | yes | – | yes | yes | 0.26 | `bus pass one twenty eight yesterday` |
| Daniel | 07 | yes | yes | **no** | – | yes | 0.28 | `god paid two thousand four hundred eighty from michael art` |
| Daniel | 08 | yes | yes | yes | – | yes | 0.26 | `textbook from the bookstore ninety nine ninety nine` |
| Daniel | 09 | yes | yes | yes | – | – | 0.25 | `netflix sixteen ninety nine` |
| Daniel | 10 | yes | yes | yes | yes | – | 0.29 | `dinner at the keg eighty four dollars and twenty cents last night` |
| Daniel | 11 | yes | yes | – | – | yes | 0.25 | `haircut thirty five dollars` |
| Daniel | 12 | yes | yes | – | – | yes | 0.26 | `phone bill sixty five dollars` |
| Daniel | 13 | yes | yes | **no** | yes | – | 0.29 | `shoppers drug mark twelve forty nine today` |
| Daniel | 14 | yes | yes | yes | – | yes | 0.27 | `twenty five us dollars on steam` |
| Daniel | 15 | yes | yes | yes | – | – | 0.27 | `gas at petro canada fifty one thirty` |
| Daniel | 16 | yes | yes | yes | yes | – | 0.26 | `spent nine fifty on bubble tea yesterday` |
| Daniel | 17 | yes | yes | yes | – | – | 0.27 | `amazon order forty two seventeen` |
| Daniel | 18 | yes | yes | – | – | yes | 0.25 | `tuition deposit five hundred dollars` |
| Daniel | 19 | yes | yes | **no** | – | – | 0.27 | `movie tickets at synaplex thirty two fifty` |
| Daniel | 20 | yes | yes | **no** | – | – | 0.27 | `refund from best by eighty nine ninety nine` |
| Karen | 01 | yes | yes | – | – | yes | 0.24 | `lunch fifteen dollars` |
| Karen | 02 | **no** | **no** | yes | – | – | 0.36 | `uber 2340` |
| Karen | 03 | yes | yes | yes | yes | – | 0.27 | `groceries at no frills sixty two eighteen yesterday` |
| Karen | 04 | yes | yes | – | – | yes | 0.29 | `paid rent one thousand one hundred fifty dollars` |
| Karen | 05 | yes | yes | yes | – | – | 0.27 | `coffee at tim hortons four seventy five` |
| Karen | 06 | yes | yes | – | yes | yes | 0.29 | `bus pass one twenty eight yesterday` |
| Karen | 07 | yes | yes | yes | – | yes | 0.3 | `got paid two thousand four hundred eighty from my co-op` |
| Karen | 08 | yes | yes | yes | – | yes | 0.26 | `textbook from the bookstore 99.99` |
| Karen | 09 | yes | yes | yes | – | – | 0.25 | `netflix sixteen ninety nine` |
| Karen | 10 | yes | yes | yes | yes | – | 0.29 | `dinner at the keg eighty four dollars and twenty cents last night` |
| Karen | 11 | yes | yes | – | – | yes | 0.25 | `haircut thirty five dollars` |
| Karen | 12 | yes | yes | – | – | yes | 0.25 | `phone bill sixty five dollars` |
| Karen | 13 | yes | yes | **no** | yes | – | 0.26 | `shoppers drugmark twelve forty nine today` |
| Karen | 14 | yes | yes | yes | – | yes | 0.28 | `twenty five us dollars on steam` |
| Karen | 15 | yes | yes | yes | – | – | 0.28 | `gas at petro canada fifty one thirty` |
| Karen | 16 | yes | yes | yes | yes | – | 0.26 | `spent nine fifty on bubble tea yesterday` |
| Karen | 17 | yes | **no** | yes | – | – | 0.25 | `amazon order 42 17` |
| Karen | 18 | yes | yes | – | – | yes | 0.4 | `tuition deposit five hundred dollars` |
| Karen | 19 | yes | yes | yes | – | – | 0.3 | `movie tickets at cineplex thirty two fifty` |
| Karen | 20 | **no** | **no** | yes | – | – | 0.3 | `refund from Best Buy 1899.` |
