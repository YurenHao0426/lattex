// CM6 extension for OT sync: ViewPlugin + annotation to prevent echo loops
import { Annotation } from '@codemirror/state'
import { ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { OverleafDocSync } from '../ot/overleafSync'

/** Annotation used to mark transactions that come from remote OT updates */
export const remoteUpdateAnnotation = Annotation.define<boolean>()

/**
 * Creates a CM6 extension that intercepts local doc changes
 * and feeds them to the OT orchestrator. Skips changes tagged
 * with remoteUpdateAnnotation to prevent echo loops.
 */
export function otSyncExtension(sync: OverleafDocSync) {
  return ViewPlugin.fromClass(
    class {
      constructor() {
        // nothing to initialize
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return

        // Skip if this change was from a remote OT update
        for (const tr of update.transactions) {
          if (tr.annotation(remoteUpdateAnnotation)) return
        }

        // Feed local changes to OT orchestrator
        // We need the old doc (before changes) — it's the startState.doc
        sync.onLocalChange(update.changes, update.startState.doc)
      }

      destroy() {
        // nothing to clean up
      }
    }
  )
}
