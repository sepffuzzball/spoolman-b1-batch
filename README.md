# spoolman-b1-batch

Renders a multi-page **40x30 mm** label PDF (as exported by Spoolman) and prints
the selected pages one-by-one to an **NIIMBOT B1** USB label printer. Spoolman is
the source application that generates the label PDFs; the printer is a NIIMBOT B1.

The CLI never contacts Spoolman over the network: it reads the PDF locally and
only talks to the printer over USB serial. No browser is needed.

## Prerequisites (Arch Linux)

Install Node.js (>= 22), npm, and the Poppler utilities used to inspect and
rasterize the PDF:

```sh
sudo pacman -S --needed nodejs npm poppler
```

Then install the pinned dependency tree from the lockfile:

```sh
npm ci
```

The exact versions are pinned: `@mmote/niimbluelib@0.47.0-node` and `sharp@0.35.3`.

## Usage

```
npm start -- <labels.pdf> [options]
```

| Option | Description |
| --- | --- |
| `--port <path>` | Serial device path. Default: `/dev/ttyACM0`. |
| `--density <1-5>` | Print density, integer 1..5. Default: `3`. |
| `--pages <spec>` | Page selection, e.g. `1` or `1,3-5`. Default: all pages. |
| `--dry-run` | Render 320x240 preview PNGs without printing (no serial needed). |
| `--output-dir <dir>` | Dry-run destination; must not already exist and its parent must exist. Default: `./label-preview`. |
| `--yes` | Skip the interactive confirmation (required when stdin is not a TTY). |
| `--help` | Show help and exit. |

Provide exactly one PDF positional argument. Pages are always printed in ascending
order, one copy each.

### Dry-run previews

```sh
npm start -- labels.pdf --dry-run --output-dir preview
```

This renders every selected page into `preview/` (the directory must not already
exist; its parent must exist) and prints a summary mapping each PDF page to its
preview file, the copy count, and the pixel dimensions. The destination is created
exclusively: if it already exists the CLI errors and leaves existing files
untouched, and if a copy later fails it removes only the directory it created.
Preview PNGs are **full-colour** renderings of the PDF; the physical B1 printer is
**monochrome**. Dry-run never opens the serial port, so it runs even with no
device attached. The printer adapter composites alpha over white and thresholds
grayscale to black/white at 180 so medium-grey label field names are preserved as
black on the physical print.

### Printing a single page

```sh
npm start -- labels.pdf --pages 1 --port /dev/ttyACM0
```

### Printing pages 1-2, then all pages

```sh
npm start -- labels.pdf --pages 1-2 --yes
npm start -- labels.pdf --yes
```

The `--pages` value is written with a space: `--pages 1-2`. Without `--yes` the
CLI asks `Print now? [y/N]` (default No). When stdin is not a TTY (scripts, CI)
`--yes` is required, otherwise the CLI fails before touching the serial port.
SIGINT during a print lets the in-flight label finish and exits with code 130, but
pushes no labels after that.

## Label PDF requirements

Every *selected visible* page must be 40x30 mm (within a 0.5 mm tolerance), one
label per page. The visible page size (after applying the PDF CropBox) is what is
validated, not the raw MediaBox: a page whose visible area is exactly 40x30 mm is
accepted even if its MediaBox is larger, whereas a page whose visible area is A4,
30x40 mm, or any other size is rejected before rasterization, so nothing partial is
printed. The native raster is ~203 DPI, i.e. **320x240 px** for a 40x30 mm label.
A 90/270 degree page rotation is accepted as long as the displayed (rotated) page
is 40x30 mm.

## Safety and limits

- The B1 device/firmware is **untested**; there is no automatic resume or retry.
- On a timeout or unconfirmed print failure the tool cancels status polling and
  closes the USB connection **without** sending a competing print-end, then stops
  the batch. The current label may still have printed: check the physical output,
  and cancel/power-cycle the printer before a manual retry. Closing the USB
  connection does not by itself stop the printer's physical action.
- Under SIGINT the currently in-flight label is allowed to complete and is ended
  normally; no further labels are queued.
- A timeout or error means "this label may have printed". The CLI never claims a
  page printed until the printer confirms physical completion.
- Permissions: your user must be able to open the serial device. If you are not
  the device owner you may need to add yourself to the relevant group (`uucp` on
  many systems) or add an appropriate udev rule.
- Protocol: the modern library is used, **one B1 task per page**, and the CLI
  waits for physical completion (`waitForFinished`) before starting the next page.
  The legacy no-op `waitForPageFinished` is never used.
- CSV export is not used; the PDF is the single source of truth.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (or cancelled at the prompt). |
| `1` | Error (bad flags, missing file, wrong page size, print failure). |
| `130` | Interrupted by SIGINT. |

## Development

```sh
npm test        # node --test test/*.test.mjs
npm run lint    # syntax-check src/cli.mjs, pdf.mjs, batch.mjs, printer.mjs
npm start       # run the CLI directly
```

The printer adapter is imported from `src/printer.mjs` only after a confirmed
print. Tests override that path with the `SPOOLMAN_B1_ADAPTER` environment
variable (default `./printer.mjs`) so they can run the whole print flow without
hardware.
