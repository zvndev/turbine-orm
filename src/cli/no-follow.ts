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
// defines neither; there the open is followed by an lstat of the name.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = constants.O_NONBLOCK ?? 0;

/** Whether `error` is an open refusing a symlink it was told not to follow (FreeBSD says EMLINK). */
export function isSymlinkRefusal(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ELOOP' || code === 'EMLINK';
}

/**
 * Open an existing file without following a symlink at its last component; a
 * symlink there is refused (see {@link isSymlinkRefusal}). The caller closes
 * the descriptor.
 */
export function openNoFollow(path: string, flags: number): number {
  const fd = openSync(path, flags | NO_FOLLOW | NON_BLOCK);
  if (!NO_FOLLOW && lstatSync(path).isSymbolicLink()) {
    closeSync(fd);
    throw Object.assign(new Error(`ELOOP: symbolic link refused, open '${path}'`), { code: 'ELOOP' });
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
