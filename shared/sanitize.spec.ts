import { test } from "node:test";
import assert from "node:assert/strict";
import { clean } from './sanitize';
test('clean turns control characters into spaces and collapses whitespace', () => {
    assert.equal(clean('a\u001b[2Jb'), 'a [2Jb');
    assert.equal(clean('  one\n\ttwo   three  '), 'one two three');
    assert.equal(clean('x\u0000y\u007fz'), 'x y z');
});
test('clean drops bidi and zero-width characters', () => {
    assert.equal(clean('a\u200bb\u202ec\u2066d\ufeffe'), 'abcde');
});
test('clean leaves plain text and box-drawing glyphs alone', () => {
    assert.equal(clean('Escape quotes ├─ done'), 'Escape quotes ├─ done');
});
