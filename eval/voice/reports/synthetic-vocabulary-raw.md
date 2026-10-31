# Dictation benchmark: synthetic, vocabulary-raw

- Model: `whisper-base.en-51eefc0` (q8), @huggingface/transformers in Node on onnxruntime-node 1.30.0 (cpu). The browser runs the same files on WASM, so numerics can differ slightly and a clip or two may score differently.
- Prompt: `vocabulary` (45 terms from `eval/voice/terms.json`), 136 tokens:

  `pizza at dominos eighteen twenty five parking seven fifty yesterday paid twelve hundred rent sobeys forty three oh six today tim hortons no frills uber amazon ca order netflix shoppers drug mart petro canada best buy the keg cineplex steam co op pay bubble tea chatime bookstore textbook grt bus pass rent landlord rogers phone bill tuition deposit walmart lcbo presto top up spotify costco zehrs dollarama starbucks lazeez shawarma williams fresh cafe pizza nova mcdonalds subway shawarma plus iphone case ebay indigo books canadian tire food basics supermarket mart freshii mr sub`
- Audio: raw; beams: 1; max_new_tokens: 96
- 60 clips, 0.3 s per clip (model load 0.3 s), 2026-10-31

| Amount usable | Strict | Merchant | Date | Keep |
| --- | --- | --- | --- | --- |
| 58/60 | 58/60 | 35/42 | 15/15 | 27/27 |

Per voice, amount usable: Samantha 19/20, Daniel 20/20, Karen 19/20. Strict: Samantha 19/20, Daniel 20/20, Karen 19/20. Merchant: Samantha 13/14, Daniel 10/14, Karen 12/14.

Prompt words copied into a transcript that the phrase did not contain: 0 clip(s).

Misses:

- amount: Samantha-02.wav → `uber 2340`; Karen-02.wav → `uber 2340`
- merchant: Samantha-20.wav → `refund from best by eighty nine ninety nine`; Daniel-02.wav → `you but twenty three forty`; Daniel-07.wav → `god paid two thousand four hundred eighty from michael`; Daniel-19.wav → `movie tickets at synaplex thirty two fifty`; Daniel-20.wav → `refund from best by eighty nine ninety nine`; Karen-07.wav → `got paid two thousand four hundred eighty from michael`; Karen-20.wav → `refund from best by eighty nine ninety nine`

| Voice | Id | Amount | Strict | Merchant | Date | Keep | s | Transcript |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Samantha | 01 | yes | yes | – | – | yes | 0.31 | `lunch fifteen dollars` |
| Samantha | 02 | **no** | **no** | yes | – | – | 0.32 | `uber 2340` |
| Samantha | 03 | yes | yes | yes | yes | – | 0.31 | `groceries at no frills sixty two eighteen yesterday` |
| Samantha | 04 | yes | yes | – | – | yes | 0.33 | `paid rent one thousand one hundred fifty dollars` |
| Samantha | 05 | yes | yes | yes | – | – | 0.34 | `coffee at tim hortons four seventy five` |
| Samantha | 06 | yes | yes | – | yes | yes | 0.3 | `bus pass 128 yesterday` |
| Samantha | 07 | yes | yes | yes | – | yes | 0.33 | `got paid two thousand four hundred eighty from my co op` |
| Samantha | 08 | yes | yes | yes | – | yes | 0.3 | `textbook from the bookstore ninety nine ninety nine` |
| Samantha | 09 | yes | yes | yes | – | – | 0.28 | `netflix sixteen ninety nine` |
| Samantha | 10 | yes | yes | yes | yes | – | 0.33 | `dinner at the keg eighty four dollars and twenty cents last night` |
| Samantha | 11 | yes | yes | – | – | yes | 0.27 | `haircut thirty five dollars` |
| Samantha | 12 | yes | yes | – | – | yes | 0.28 | `phone bill sixty five dollars` |
| Samantha | 13 | yes | yes | yes | yes | – | 0.3 | `shoppers drug mart twelve forty nine today` |
| Samantha | 14 | yes | yes | yes | – | yes | 0.3 | `twenty five-us-dollars on steam` |
| Samantha | 15 | yes | yes | yes | – | – | 0.3 | `gasset petro canada fifty one thirty` |
| Samantha | 16 | yes | yes | yes | yes | – | 0.29 | `spent nine fifty on bubble tea yesterday` |
| Samantha | 17 | yes | yes | yes | – | – | 0.29 | `amazon order forty two seventeen` |
| Samantha | 18 | yes | yes | – | – | yes | 0.28 | `tuition deposit five hundred dollars` |
| Samantha | 19 | yes | yes | yes | – | – | 0.3 | `movie tickets at cineplex thirty two fifty` |
| Samantha | 20 | yes | yes | **no** | – | – | 0.29 | `refund from best by eighty nine ninety nine` |
| Daniel | 01 | yes | yes | – | – | yes | 0.27 | `lunch fifteen dollars` |
| Daniel | 02 | yes | yes | **no** | – | – | 0.28 | `you but twenty three forty` |
| Daniel | 03 | yes | yes | yes | yes | – | 0.31 | `groceries at no frills sixty two eighteen yesterday` |
| Daniel | 04 | yes | yes | – | – | yes | 0.29 | `paid rent one thousand one hundred fifty dollars` |
| Daniel | 05 | yes | yes | yes | – | – | 0.3 | `coffee ad tim hortons four seventy five` |
| Daniel | 06 | yes | yes | – | yes | yes | 0.29 | `bus pass one twenty eight yesterday` |
| Daniel | 07 | yes | yes | **no** | – | yes | 0.3 | `god paid two thousand four hundred eighty from michael` |
| Daniel | 08 | yes | yes | yes | – | yes | 0.29 | `textbook from the bookstore ninety nine ninety nine` |
| Daniel | 09 | yes | yes | yes | – | – | 0.28 | `netflix sixteen ninety nine` |
| Daniel | 10 | yes | yes | yes | yes | – | 0.32 | `dinner at the keg eighty four dollars and twenty cents last night` |
| Daniel | 11 | yes | yes | – | – | yes | 0.29 | `haircut thirty five dollars` |
| Daniel | 12 | yes | yes | – | – | yes | 0.28 | `phone bill sixty five dollars` |
| Daniel | 13 | yes | yes | yes | yes | – | 0.29 | `shoppers drug mart twelve forty nine today` |
| Daniel | 14 | yes | yes | yes | – | yes | 0.31 | `twenty five-us-dollars on steam` |
| Daniel | 15 | yes | yes | yes | – | – | 0.3 | `gas at petro canada fifty one thirty` |
| Daniel | 16 | yes | yes | yes | yes | – | 0.3 | `spent nine fifty on bubble tea yesterday` |
| Daniel | 17 | yes | yes | yes | – | – | 0.29 | `amazon order forty two seventeen` |
| Daniel | 18 | yes | yes | – | – | yes | 0.28 | `tuition deposit five hundred dollars` |
| Daniel | 19 | yes | yes | **no** | – | – | 0.3 | `movie tickets at synaplex thirty two fifty` |
| Daniel | 20 | yes | yes | **no** | – | – | 0.29 | `refund from best by eighty nine ninety nine` |
| Karen | 01 | yes | yes | – | – | yes | 0.27 | `lunch fifteen dollars` |
| Karen | 02 | **no** | **no** | yes | – | – | 0.27 | `uber 2340` |
| Karen | 03 | yes | yes | yes | yes | – | 0.3 | `groceries at no frills sixty two eighteen yesterday` |
| Karen | 04 | yes | yes | – | – | yes | 0.29 | `paid rent one thousand one hundred fifty dollars` |
| Karen | 05 | yes | yes | yes | – | – | 0.3 | `coffee at tim hortons four seventy five` |
| Karen | 06 | yes | yes | – | yes | yes | 0.28 | `bus pass one twenty eight yesterday` |
| Karen | 07 | yes | yes | **no** | – | yes | 0.3 | `got paid two thousand four hundred eighty from michael` |
| Karen | 08 | yes | yes | yes | – | yes | 0.3 | `textbook from the bookstore nineteen ninety nine ninety nine` |
| Karen | 09 | yes | yes | yes | – | – | 0.28 | `netflix sixteen ninety nine` |
| Karen | 10 | yes | yes | yes | yes | – | 0.32 | `dinner at the keg eighty four dollars and twenty cents last night` |
| Karen | 11 | yes | yes | – | – | yes | 0.29 | `haircut thirty five dollars` |
| Karen | 12 | yes | yes | – | – | yes | 0.28 | `phone bill sixty five dollars` |
| Karen | 13 | yes | yes | yes | yes | – | 0.32 | `shoppers drug mart twelve forty nine today` |
| Karen | 14 | yes | yes | yes | – | yes | 0.31 | `twenty five-us-dollars on steam` |
| Karen | 15 | yes | yes | yes | – | – | 0.3 | `gas at petro canada fifty one thirty` |
| Karen | 16 | yes | yes | yes | yes | – | 0.29 | `spent nine fifty on bubble tea yesterday` |
| Karen | 17 | yes | yes | yes | – | – | 0.28 | `amazon order forty two seventeen` |
| Karen | 18 | yes | yes | – | – | yes | 0.28 | `tuition deposit five hundred dollars` |
| Karen | 19 | yes | yes | yes | – | – | 0.3 | `movie tickets at cineplex thirty two fifty` |
| Karen | 20 | yes | yes | **no** | – | – | 0.29 | `refund from best by eighty nine ninety nine` |
