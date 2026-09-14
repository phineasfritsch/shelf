// Pure-function tests for public/textdiff.js (splice, shiftSelection, findUrls). No server needed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splice, shiftSelection, findUrls } from '../public/textdiff.js';

// Applies a splice result to a string - used to check every case round-trips to the new text.
function apply(oldS, { index, remove, insert }) {
  return oldS.slice(0, index) + insert + oldS.slice(index + remove);
}

describe('splice', () => {
  test('typing at the end', () => {
    const r = splice('ab', 'abc', 3);
    assert.deepEqual(r, { index: 2, remove: 0, insert: 'c' });
    assert.equal(apply('ab', r), 'abc');
  });

  test('typing into an empty string', () => {
    assert.deepEqual(splice('', 'a', 1), { index: 0, remove: 0, insert: 'a' });
  });

  test('typing in the middle', () => {
    const r = splice('helo', 'hello', 4);
    assert.equal(apply('helo', r), 'hello');
    assert.equal(r.remove, 0);
    assert.equal(r.insert, 'l');
  });

  test("'aa' → 'aaa' uses the caret to place the insert", () => {
    // caret after the first char: the new 'a' was typed at index 1 (prefix scan stops at the caret)
    assert.deepEqual(splice('aa', 'aaa', 1), { index: 1, remove: 0, insert: 'a' });
    // caret at the end: appended
    assert.deepEqual(splice('aa', 'aaa', 3), { index: 2, remove: 0, insert: 'a' });
    // caret at the very start: inserted at 0
    assert.deepEqual(splice('aa', 'aaa', 0), { index: 0, remove: 0, insert: 'a' });
  });

  test('caret defaults to the end of the new string', () => {
    assert.deepEqual(splice('aa', 'aaa'), { index: 2, remove: 0, insert: 'a' });
  });

  test('backspace', () => {
    const r = splice('abc', 'ac', 1);
    assert.deepEqual(r, { index: 1, remove: 1, insert: '' });
    assert.equal(apply('abc', r), 'ac');
  });

  test('delete forward at the caret', () => {
    const r = splice('abcd', 'abd', 2);
    assert.deepEqual(r, { index: 2, remove: 1, insert: '' });
  });

  test('replace a selection', () => {
    const r = splice('hello world', 'hello there', 11);
    assert.deepEqual(r, { index: 6, remove: 5, insert: 'there' });
    assert.equal(apply('hello world', r), 'hello there');
  });

  test('replace everything', () => {
    const r = splice('abc', 'xyz', 3);
    assert.deepEqual(r, { index: 0, remove: 3, insert: 'xyz' });
  });

  test('clear', () => {
    assert.deepEqual(splice('abc', '', 0), { index: 0, remove: 3, insert: '' });
  });

  test('no change', () => {
    assert.deepEqual(splice('abc', 'abc', 2), { index: 2, remove: 0, insert: '' });
  });

  test('paste multi-line at caret', () => {
    const r = splice('a\nb', 'a\nX\nY\nb', 6);
    assert.equal(apply('a\nb', r), 'a\nX\nY\nb');
    assert.equal(r.remove, 0);
    assert.equal(r.insert, 'X\nY\n');
  });

  test('never splits a surrogate pair on the prefix side', () => {
    // 😀 = 😀, 😁 = 😁 - they share the high surrogate
    const r = splice('a😀', 'a😁', 3);
    assert.deepEqual(r, { index: 1, remove: 2, insert: '😁' });
    assert.equal(apply('a😀', r), 'a😁');
  });

  test('never splits a surrogate pair on the suffix side', () => {
    // suffix scan matches the shared low surrogate; it must back off to the pair boundary
    const r = splice('a🈀', 'b😀', 1);
    assert.deepEqual(r, { index: 0, remove: 3, insert: 'b😀' });
    assert.equal(apply('a🈀', r), 'b😀');
  });

  test('appending an emoji', () => {
    const r = splice('😀', '😀😀', 4);
    assert.deepEqual(r, { index: 2, remove: 0, insert: '😀' });
  });

  test('replacing a whole emoji at the caret', () => {
    const r = splice('😀', '😁', 2);
    assert.deepEqual(r, { index: 0, remove: 2, insert: '😁' });
  });

  test('random round-trips', () => {
    // deterministic LCG so failures reproduce
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const alphabet = 'abc\n ';
    for (let i = 0; i < 300; i++) {
      let s = '';
      for (let k = rnd(8); k > 0; k--) s += alphabet[rnd(alphabet.length)];
      const at = rnd(s.length + 1);
      const del = rnd(s.length - at + 1);
      let ins = '';
      for (let k = rnd(4); k > 0; k--) ins += alphabet[rnd(alphabet.length)];
      const next = s.slice(0, at) + ins + s.slice(at + del);
      const r = splice(s, next, at + ins.length);
      assert.equal(apply(s, r), next, `case ${i}: ${JSON.stringify({ s, next, at, del, ins, r })}`);
    }
  });
});

describe('shiftSelection', () => {
  test('remote insert before the caret shifts it', () => {
    assert.deepEqual(shiftSelection(5, 5, [{ insert: 'ab' }]), [7, 7]);
    assert.deepEqual(shiftSelection(5, 5, [{ retain: 2 }, { insert: 'xyz' }]), [8, 8]);
  });

  test('remote insert exactly at a collapsed caret lands before it', () => {
    assert.deepEqual(shiftSelection(5, 5, [{ retain: 5 }, { insert: 'ab' }]), [7, 7]);
  });

  test('remote insert after the caret leaves it alone', () => {
    assert.deepEqual(shiftSelection(5, 5, [{ retain: 6 }, { insert: 'x' }]), [5, 5]);
  });

  test('insert at the end of a selection does not extend it', () => {
    assert.deepEqual(shiftSelection(3, 7, [{ retain: 7 }, { insert: 'x' }]), [3, 7]);
  });

  test('insert at the start of a selection shifts the whole selection', () => {
    assert.deepEqual(shiftSelection(3, 7, [{ retain: 3 }, { insert: 'xy' }]), [5, 9]);
  });

  test('insert inside a selection grows it', () => {
    assert.deepEqual(shiftSelection(3, 7, [{ retain: 5 }, { insert: 'xy' }]), [3, 9]);
  });

  test('remote delete before the caret shifts it back', () => {
    assert.deepEqual(shiftSelection(5, 5, [{ retain: 1 }, { delete: 2 }]), [3, 3]);
  });

  test('remote delete spanning the caret clamps to the delete position', () => {
    assert.deepEqual(shiftSelection(5, 5, [{ retain: 3 }, { delete: 5 }]), [3, 3]);
  });

  test('remote delete after the caret leaves it alone', () => {
    assert.deepEqual(shiftSelection(5, 5, [{ retain: 6 }, { delete: 2 }]), [5, 5]);
  });

  test('delete inside a selection shrinks it', () => {
    assert.deepEqual(shiftSelection(3, 7, [{ retain: 4 }, { delete: 2 }]), [3, 5]);
  });

  test('delete covering the whole selection collapses it', () => {
    assert.deepEqual(shiftSelection(3, 7, [{ retain: 1 }, { delete: 10 }]), [1, 1]);
  });

  test('delete overlapping the start of a selection', () => {
    assert.deepEqual(shiftSelection(3, 7, [{ retain: 1 }, { delete: 4 }]), [1, 3]);
  });

  test('mixed delta: retain, delete, insert', () => {
    // 'abcdefghij' with selection [4,8]; remote: keep 2, delete 2, insert 'XYZ' → prefix length 2 + 3
    assert.deepEqual(shiftSelection(4, 8, [{ retain: 2 }, { delete: 2 }, { insert: 'XYZ' }]), [5, 9]);
  });

  test('empty delta is a no-op', () => {
    assert.deepEqual(shiftSelection(2, 4, []), [2, 4]);
  });

  test('caret at 0 with insert at 0 moves after the inserted text', () => {
    assert.deepEqual(shiftSelection(0, 0, [{ insert: 'ab' }]), [2, 2]);
  });
});

describe('findUrls', () => {
  test('returns nothing for plain text', () => {
    assert.deepEqual(findUrls(''), []);
    assert.deepEqual(findUrls('no links here'), []);
  });

  test('finds http and https URLs', () => {
    const urls = findUrls('see https://a.example/x?y=1 and http://b.example/path here');
    assert.deepEqual(urls, ['https://a.example/x?y=1', 'http://b.example/path']);
  });

  test('ignores non-http schemes', () => {
    assert.deepEqual(findUrls('ftp://files.example/a mailto:x@y.z'), []);
  });

  test('dedupes', () => {
    const urls = findUrls('https://a.example/x https://a.example/x\nhttps://a.example/x');
    assert.deepEqual(urls, ['https://a.example/x']);
  });

  test('caps at 20', () => {
    const text = Array.from({ length: 25 }, (_, i) => `https://h${i}.example/`).join('\n');
    const urls = findUrls(text);
    assert.equal(urls.length, 20);
    assert.equal(urls[0], 'https://h0.example/');
    assert.equal(urls[19], 'https://h19.example/');
  });

  test('URLs on their own lines', () => {
    assert.deepEqual(findUrls('https://one.example\nhttps://two.example'), ['https://one.example', 'https://two.example']);
  });
});
