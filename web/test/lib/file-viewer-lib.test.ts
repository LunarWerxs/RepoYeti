import { describe, it, expect, beforeEach } from "vitest";
import {
  fileViewer,
  editorDirty,
  discardDialogOpen,
  openFile,
  closeFile,
  resolveDiscard,
  dismissViewerForRepo,
} from "@/lib/file-viewer";

// dismissViewerForRepo zeroes the reactive `state`, but the unsaved-edits prompt is tracked by the
// module-private `pendingDiscard` resolver. When a guarded close/switch raised that prompt and the
// repo vanished before the user answered, the prompt used to survive the dismiss: the dialog stayed
// on screen with no editor behind it, and the awaiting close/switch promise never settled. These
// tests pin the settle-then-dismiss behaviour.
describe("dismissViewerForRepo settles a pending discard prompt", () => {
  beforeEach(() => {
    resolveDiscard(false); // clear any prompt a previous test left open
    fileViewer.open = false;
    fileViewer.target = null;
    editorDirty.value = false;
  });

  it("clears the dialog and resolves a pending closeFile when the repo is removed", async () => {
    await openFile({ repoId: "A", path: "a.txt" });
    editorDirty.value = true;
    const closing = closeFile(); // raises the discard prompt and awaits the answer
    expect(discardDialogOpen.value).toBe(true);

    dismissViewerForRepo("A");

    expect(discardDialogOpen.value).toBe(false); // dialog went away with the viewer
    expect(fileViewer.open).toBe(false);
    expect(fileViewer.target).toBeNull();
    await expect(closing).resolves.toBeUndefined(); // the leaked resolver settled
  });

  it("settles a pending openFile switch too", async () => {
    await openFile({ repoId: "A", path: "a.txt" });
    editorDirty.value = true;
    const switching = openFile({ repoId: "A", path: "b.txt" });
    expect(discardDialogOpen.value).toBe(true);

    dismissViewerForRepo("A");

    expect(discardDialogOpen.value).toBe(false);
    await expect(switching).resolves.toBeUndefined();
  });

  it("leaves a prompt belonging to another repo's viewer alone", async () => {
    await openFile({ repoId: "A", path: "a.txt" });
    editorDirty.value = true;
    void closeFile();
    expect(discardDialogOpen.value).toBe(true);

    dismissViewerForRepo("B"); // different repo — no-op

    expect(discardDialogOpen.value).toBe(true);
    resolveDiscard(false);
  });
});
