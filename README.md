# EvenSound

Free, open-source real-time loudness levelling for Chrome.

**Current version:** 0.6.1. This is the tested DSP build; further interface simplification is planned.

## Installation


Unpack the ZIP, open `chrome://extensions`, enable Developer mode, and select **Load unpacked**. Remove or disable older copies first. Choose the folder containing `manifest.json`.

Open Disney+ in Chrome, play a programme, then click **Start on this tab**. Chrome routes the captured audio through the extension. The extension performs all processing locally. The popup need not remain open.

- **Target loudness**: −50 to −12 LUFS, initially −28. Lower means quieter.
- **Levelling strength**: 0–100%, initially 100. Higher means less variation in programme loudness, within the gain limits.
- **Enable levelling**: disables gain processing for a bypass comparison.
- **Graph**: input 3-second loudness, estimated post-gain loudness, target; it resets when you reopen the popup.

## DSP behaviour

K-weighted two-channel energy is measured in 100 ms blocks. A 400 ms window reacts to newly loud sections, while a 3-second window suppresses pumping between dialogue phrases. The controller uses the louder of the two windows to determine gain, adjusts down with a roughly 90 ms time constant and back up with a 1.4-second time constant, with maximum reduction of 48 dB and maximum amplification of 18 dB. Very quiet passages are not boosted towards the target, and a stereo-linked sample peak safety limiter prevents output samples above approximately −0.26 dBFS. Limiting and gain clamps mean the target cannot always be achieved. There is no lookahead or true-peak measurement. Short-term loudness is a K-weighted BS.1770 approximation, not a certified EBU R128 meter.

For a listening test, start at −28 LUFS and 100% strength. Listen to normal dialogue followed by a theme. Lower the target if the entire output is too loud. If sustained themes are still too loud relative to dialogue, note the gap and the numbers shown in the graph.

## v0.6.1 — episode-transition start-up protection

The DSP now starts with a safe -24 dB attenuation instead of unity gain while its first 400 ms loudness reading is collected. If the same tab was previously captured, it restores the last measured attenuation (clamped to -48 to -6 dB) when starting capture again. The controller then converges to the configured target. It may briefly sound quieter during start-up instead of allowing a loud burst.

**Limitation:** if Chrome ends the capture on navigation and plays audio directly before capture can resume, an extension cannot attenuate that uncaptured audio. The change only protects audio passing through the processor.
