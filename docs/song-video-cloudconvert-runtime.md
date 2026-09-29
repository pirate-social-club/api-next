# CloudConvert song-video runtime

The media-processor Worker owns provider creation, strict PCM master verification, immutable R2 output and the existing database seal. The staging switch `VIDEO_CLOUDCONVERT_RENDER_ENABLED` remains false. This change contains no production flag or credential. The workstation renderer remains until a newly admitted staging song completes the full CloudConvert journey.

The database records a thirty-minute provider deadline before dispatch. A durable create intent precedes the only POST. A lost acknowledgement is observed by exact attempt tag; an empty search is inconclusive and duplicate jobs cannot become a master. Two outstanding create intents occupy the fixed capacity, including unresolved responses. The job ID, PCM digest and deadline are immutable.

The excerpt is at most fifteen seconds of admitted, version-bound stereo PCM. Its WAV grant expires after fifteen minutes or at the earlier provider deadline. It authorizes that exact transient object through the source gateway. The capture grant authorizes the sealed source's recorded media type and object identity. Provider output never receives R2 write credentials. Downloads and Worker readback are bounded to 24 MiB, independently checked and verified again before sealing. The database checks `clock_timestamp()` at master insertion and the started-to-sealed transition, after verification; a late transaction rolls back.

## Staging activation receipt

Review the slice and pin its merge before activation. Apply the current migration suffix, including the provider-attempt and excerpt-grant migration, before deploying the updated source gateway. The new gateway queries the excerpt table, even when resolving an ordinary video grant. Verify the live database grants, R2 binding and source gateway before enabling the renderer.

Provision a separate staging `CLOUDCONVERT_RENDER_API_KEY` with only provider `task.read` and `task.write` scopes. Bind it only to the media-processor Worker. The staging configuration declares it as a secret. The optional operator `CLOUDCONVERT_API_KEY` stays in operator custody and is never a runtime substitute. Check installed secret names and live bindings rather than inferring deployment state from this file.

Enable only the staging switch for the bounded watched render. Record the actual export host, dispatch-to-start time, provider render time and credits, author-visible completion, Worker CPU and memory, and the accepted master's durable identity. This first real master supplies the frame-comparison gate. Audio verification alone does not open ordinary-user access.

## Cleanup and reconciliation

Accepted and refused outcomes revoke input grants, search by the exact attempt tag, delete all matching or recorded provider jobs, and delete transient excerpts, including an attempt key written before its grant was recorded. A replay of accepted-master lookup retries cleanup. Expiry first persists reconciliation evidence and runs the same deletion path. A provider DELETE returning 404 proves that job is absent and permits replay. A lost DELETE response leaves cleanup incomplete.

An empty search after an uncertain create does not release the intent or authorize another POST. The `song_video_provider_reconciliation` log reports this unresolved state without a key, bearer URL or provider response body. This structured event is a source for the renderer alert; live alert delivery remains a release gate.

The operator command previews an expired attempt with no writes:

```sh
bun scripts/song-video-cloudconvert-reconciliation.ts --attempt ATTEMPT_ID
```

It requires operator database and provider credentials through `CONTROL_PLANE_DATABASE_URL` and `CLOUDCONVERT_API_KEY`. To revoke inputs and delete leftovers, use the explicit `--apply --immutable-bucket BUCKET_NAME` options with the selected Cloudflare account in `CLOUDFLARE_ACCOUNT_ID`. The command refuses an attempt still within its provider wait unless reconciliation is already required. It cannot create, seal, accept or publish a video. Preview and apply results include identities and cleanup completion only. An unresolved empty lookup requires further operator investigation; rerunning cannot create a replacement job.

Reconcile in-flight CloudConvert intents before rolling back the switch. Reverting the staging switch restores observation of workstation attempts for new dispatches. Existing CloudConvert intents retain their renderer identity and need cleanup or explicit reconciliation; a rollback must not reassign or rerender them. Retain the previous serving versions of both Workers and record the actual rollout and rollback targets with the staging receipt.
