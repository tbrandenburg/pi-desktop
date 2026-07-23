#!/bin/sh

retry() {
	attempt=1
	max_attempts=3
	until timeout 1800 "$@"; do
		if [ "$attempt" -ge "$max_attempts" ]; then
			echo "Command failed after $attempt attempts: $*" >&2
			return 1
		fi
		attempt=$((attempt + 1))
		echo "Retrying ($attempt/$max_attempts): $*" >&2
	done
}

#retry opencode run --model "github-copilot/claude-sonnet-5" "Read docs/INITIAL.md fully. Tonight we're focussing on a linux app, runnable on this system. An example provider configuration can be found in .pi folder. Create TODOs for all required implementation steps (but start with minimal agent guidelines in AGENTS.md as first TODO). Conduct all the TODOs."
retry opencode run --model "github-copilot/claude-sonnet-5" "Check if we have the most important high-signal integration tests (maximum 5). In case of needed fixes, add them."
retry opencode run --model "github-copilot/claude-sonnet-5" "Check if we have the most important high-signal integration tests (maximum 5). In case of needed fixes, add them."
retry opencode run --model "github-copilot/claude-sonnet-5" "Check if we have the most important high-signal integration tests (maximum 5). In case of needed fixes, add them."
retry opencode run --model "github-copilot/claude-sonnet-5" "Create a proper gitignore and a makefile with the most important targets. Prepare the windows build (despite running on Linux here)."
retry opencode run --model "github-copilot/claude-sonnet-5" "Review the implementation against docs/INITIAL.md fully. Tonight we're focussing on a linux app, runnable on this system. Create TODOs for all gaps. Conduct the TODOs."
retry opencode run --model "github-copilot/claude-sonnet-5" "Review the implementation against docs/INITIAL.md fully. Tonight we're focussing on a linux app, runnable on this system. Create TODOs for all gaps. Conduct the TODOs."
retry opencode run --model "github-copilot/claude-sonnet-5" "Review the implementation against docs/INITIAL.md fully. Tonight we're focussing on a linux app, runnable on this system. Create TODOs for all gaps. Conduct the TODOs."
retry opencode run --model "github-copilot/claude-sonnet-5" "Run the app end-2-end. Find the most simplest way to test the UI with real-world usage scenarios (most important: session browsing+recovery, model-selection and a multi-turn chat experience). Check on aesthetics, simplicity and robustness. Removals over additions. In case of needed fixes, fix them. Record lessons learned in AGENTS.md."
retry opencode run --model "github-copilot/claude-sonnet-5" "Run the app end-2-end. Find the most simplest way to test the UI with real-world usage scenarios (most important: session browsing+recovery, model-selection and a multi-turn chat experience). Check on aesthetics, simplicity and robustness. Removals over additions. In case of needed fixes, fix them. Record lessons learned in AGENTS.md."
retry opencode run --model "github-copilot/claude-sonnet-5" "Run the app end-2-end. Find the most simplest way to test the UI with real-world usage scenarios (most important: session browsing+recovery, model-selection and a multi-turn chat experience). Check on aesthetics, simplicity and robustness. Removals over additions. In case of needed fixes, fix them. Record lessons learned in AGENTS.md."
retry opencode run --model "github-copilot/claude-sonnet-5" "Update makefile with the most important targets if needed."
retry opencode run --model "github-copilot/claude-sonnet-5" "Tidy up the repo if needed and commit."
