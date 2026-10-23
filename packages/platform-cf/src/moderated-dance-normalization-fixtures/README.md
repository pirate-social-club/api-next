# Synthetic normalization output

This is actual CloudConvert FFmpeg 6.1.4 framehash output observed on 2026-10-23 for a synthetic recording. It contains no participant media or personal data. Its SHA-256 is 09464db65caf50166b7c25c63b040907a573ead4aa5d26fd202e942e984a4bea.

The input derives from the documented synthetic master in ../song-video-master-verifier/fixtures/. A 146773-byte H.264/AAC preparation was repeated three times with stream copy, producing a 437065-byte file with SHA-256 81ef88dfb86119039ba274c41cf3dd4becee121ec764bf3bbd9a057b582d11d1. No recording was captured from a person.

The final recipe selects source [2000,8001) milliseconds, resamples to ten frames per second, bounds the output to ceil(6001*10/1000)=61 frames, and produces 64x64 grayscale frame hashes. The provider completed all four command tasks with the pinned engine and returned three JPEG samples. Both original provider jobs were recovered by their original tags and verified deleted.

Before this repair, upward FPS rounding returned the same 61 frames for the shorter [2000,8000) interval, which must contain only 60 normalized frames. A duration-based output trim fixed that integer boundary but rounded 6001ms down to 60 frames. Bounding by frame count preserves fractional boundaries without padding missing frames or weakening the parser. The normalization policy hash uses the v2 domain to distinguish the corrected recipe.

This fixture establishes the observed output format and boundary semantics. It does not prove camera capture, R2, deployed Worker execution, replay equivalence under every transcode, safety screening or operational policy admission.
