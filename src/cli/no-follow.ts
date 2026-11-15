/**
 * Open-once access to a file the CLI must not follow through a symlink. A check
 * on a path (`lstat`) followed by a read of that path can see two different
 * files, because the name can be replaced in between. Here the file is opened
 * once, without following a symlink at its last component, and the checks and
 * the read go through that descriptor. Zero imports beyond node:fs.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from 'node:fs';

// O_NOFOLLOW makes the open itself refuse a symlink at the last component, and
// O_NONBLOCK keeps a FIFO planted at the name from stalling the open. Windows
// defines neither; there the open is checked against an lstat of the name.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = constants.O_NONBLOCK ?? 0;

/**
 * Whether `error` is an open refusing the name: a symlink it was told not to
 * follow (ELOOP; FreeBSD says EMLINK), or an entry that is not a file and
 * cannot be opened as one (ENXIO: a socket).
 */
export function isRefusedOpen(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ELOOP' || code === 'EMLINK' || code === 'ENXIO';
}

/** Whether `error` is an open for writing refused by permissions or a read-only filesystem. */
export function isWriteRefusal(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

/**
 * Open an existing file without following a symlink at its last component; a
 * symlink there is refused (see {@link isRefusedOpen}). The caller closes the
 * descriptor. `noFollow` is the platform's `O_NOFOLLOW` and is a parameter only
 * so tests can run the fallback for platforms without it.
 */
export function openNoFollow(path: string, flags: number, noFollow = NO_FOLLOW): number {
  const fd = openSync(path, flags | noFollow | NON_BLOCK);
  if (noFollow) return fd;
  // Without O_NOFOLLOW the open follows a symlink, so the descriptor is kept
  // only when the name is not a symlink and still names the file that opened.
  try {
    const named = lstatSync(path, { bigint: true });
    const opened = fstatSync(fd, { bigint: true });
    if (named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino) {
      throw Object.assign(new Error(`ELOOP: symbolic link refused, open '${path}'`), { code: 'ELOOP' });
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

/**
 * Read an existing file through one descriptor. `admit` receives that
 * descriptor's stat and throws to refuse it, so the file it accepts is the
 * file that is read.
 */
export function readNoFollow(path: string, admit: (stat: Stats) => void): Buffer {
  const fd = openNoFollow(path, constants.O_RDONLY);
  try {
    admit(fstatSync(fd));
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
