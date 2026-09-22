# Benchmark reports

No benchmark result is committed by the data-engine implementation alone. Generate reports only after running the real adapter on a documented browser and device.

A report must include the model and immutable revision, runtime version, browser build, operating system, hardware class, cache state, input corpus revision, failures, and actual measurements. Keep schema validity separate from semantic correctness. Keep cold and warm timings separate, retain raw samples, and state the percentile method. Cancellation claims require an observed in-flight cancel result, no completion or tokens after abort, and a successful recovery inference. Do not infer GPU memory, energy use, or cost savings when those values were not measured.
