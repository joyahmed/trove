import { describe, expect, it } from 'vitest';
import { destinationProblem } from './extract-destination';

describe('destinationProblem', () => {
  it.each(['C:\\Backups', 'e:/stick', '/media/stick', '\\\\nas\\share\\x', '  /tmp/x  '])(
    'accepts %s',
    (p) => expect(destinationProblem(p)).toBeNull(),
  );
  it.each(['', '   ', 'relative/dir', 'stick', 'C:', 'C:\\a.zip\u0000inner'])('refuses %j', (p) =>
    expect(destinationProblem(p)).not.toBeNull(),
  );
});
