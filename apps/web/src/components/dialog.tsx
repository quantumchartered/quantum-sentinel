import * as Dialog from "@radix-ui/react-dialog";
import { type ReactNode, useState } from "react";
import { Button } from "./ui";

/**
 * Confirmation dialog with an optional required reason. Focus is trapped and
 * Escape closes it (Radix). The confirm button stays disabled until a reason
 * of at least 3 characters is entered when `reasonLabel` is set.
 */
export function ConfirmDialog({
  trigger,
  title,
  children,
  confirmLabel,
  tone = "primary",
  reasonLabel,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  reasonLabel?: string;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const needsReason = !!reasonLabel;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (setOpen(o), o || setReason(""))}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-strong bg-panel p-5 shadow-2xl">
          <Dialog.Title className="text-base font-semibold text-ink">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 text-sm text-ink-dim">{children}</div>
          </Dialog.Description>
          {needsReason && (
            <label className="mt-4 block text-sm text-ink">
              {reasonLabel}
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm text-ink"
              />
            </label>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button tone="ghost">Cancel</Button>
            </Dialog.Close>
            <Button
              tone={tone}
              disabled={busy || (needsReason && reason.trim().length < 3)}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm(reason.trim());
                  setOpen(false);
                  setReason("");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Working…" : confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
