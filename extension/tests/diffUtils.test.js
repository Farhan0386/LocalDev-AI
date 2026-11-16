const assert = require('node:assert/strict');
const test = require('node:test');
const { applyUnifiedDiff } = require('../out/diffUtils.js');

test('applies unified diff successfully to original text', () => {
  const original = [
    'def greet(name):',
    '    print("Hello")',
    '    return name',
  ].join('\n');

  const patch = [
    '--- a/test.py',
    '+++ b/test.py',
    '@@ -1,3 +1,3 @@',
    ' def greet(name):',
    '-    print("Hello")',
    '+    print(f"Hello {name}")',
    '     return name',
  ].join('\n');

  const expected = [
    'def greet(name):',
    '    print(f"Hello {name}")',
    '    return name',
  ].join('\n');

  const patched = applyUnifiedDiff(patch, original);
  assert.equal(patched, expected);
});

test('rejects mismatched hunk in unified diff', () => {
  const original = [
    'def different():',
    '    pass',
  ].join('\n');

  const patch = [
    '@@ -1,2 +1,2 @@',
    '-def target():',
    '+def target_fixed():',
    '     pass',
  ].join('\n');

  const patched = applyUnifiedDiff(patch, original);
  assert.equal(patched, undefined);
});
