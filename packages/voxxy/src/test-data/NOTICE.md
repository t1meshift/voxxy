# Test data from pySBD

`pysbd-en.json`, `pysbd-es-golden.json` and `pysbd-es-more.json` are the sentence-splitting test cases of
[pySBD](https://github.com/nipunsadvilkar/pySBD) (`tests/lang/test_english.py`, `tests/lang/test_spanish.py`), converted to
JSON (`text`, `expected` sentences, `xfail` where pySBD marks the case as a known failure). The Spanish file keeps the
`GOLDEN_ES_RULES_TEST_CASES` and `ES_MORE_TEST_CASES` lists. They are used only by `sentences.golden.test.ts` to measure
`SentenceSplitter`; no pySBD code is included.

pySBD is distributed under the MIT licence:

```
MIT License

Copyright (c) 2019 Nipun Sadvilkar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
