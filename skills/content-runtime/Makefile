PROJECT ?= ~/ai-content-system
RUNTIME := python3 scripts/content_runtime.py --project $(PROJECT)
DIRECTOR := python3 scripts/content_pipeline.py --project $(PROJECT)

.PHONY: init status next flow content-flow write read brain validate-file session-boot session-route session-update session-state help

init:
	$(RUNTIME) init

status:
	$(DIRECTOR) status

next:
	$(DIRECTOR) next $(if $(SLUG),--slug $(SLUG))

flow:
	@if [ -z "$(INTAKE)" ]; then \
		echo "用法: make flow PROJECT=... INTAKE=/path/to/intake.md [SLUG=demo]"; \
		exit 1; \
	fi
	$(DIRECTOR) flow $(if $(INTAKE),--intake $(INTAKE)) $(if $(SLUG),--slug $(SLUG))

write:
	@if [ -z "$(STEP)" ] || [ -z "$(SLUG)" ] || [ -z "$(FILE)" ]; then \
		echo "用法: make write PROJECT=... STEP=intake SLUG=demo FILE=output.md"; \
		exit 1; \
	fi
	$(RUNTIME) write --step $(STEP) --slug $(SLUG) --content @$(FILE) $(if $(SOURCE),--source "$(SOURCE)")

read:
	@if [ -z "$(STEP)" ]; then \
		echo "用法: make read PROJECT=... STEP=intake"; \
		exit 1; \
	fi
	$(RUNTIME) read --step $(STEP) --latest

brain:
	@if [ -z "$(FILE)" ]; then \
		echo "用法: make brain PROJECT=... FILE=insights.md CONTENT='...'"; \
		exit 1; \
	fi
	$(RUNTIME) brain --file $(FILE) --content "$(CONTENT)"

validate-file:
	@if [ -z "$(STEP)" ] || [ -z "$(FILE)" ]; then \
		echo "用法: make validate-file PROJECT=... STEP=intake FILE=path"; \
		exit 1; \
	fi
	$(RUNTIME) validate --step $(STEP) --file $(FILE)

help:
	@echo "content-runtime · Makefile"
	@echo "  make init PROJECT=~/ai-content-system"
	@echo "  make status PROJECT=~/ai-content-system"
	@echo "  make next PROJECT=~/ai-content-system [SLUG=demo]"
	@echo "  make flow PROJECT=... INTAKE=/path/to/intake.md [SLUG=demo]"
	@echo "  make content-flow PROJECT=... INTAKE=/path/to/intake.md [SLUG=demo]"
	@echo "  make write PROJECT=... STEP=intake SLUG=demo FILE=output.md [SOURCE=...]"
	@echo "  make read PROJECT=... STEP=intake"
	@echo "  make brain PROJECT=... FILE=insights.md CONTENT='...'"
	@echo "  make validate-file PROJECT=... STEP=intake FILE=..."

content-flow: flow
session-boot:
	python3 scripts/session_manager.py --project $(PROJECT) boot $(if $(FORCE),--force)

session-route:
	@if [ -z "$(INPUT)" ]; then \
		echo "用法: make session-route PROJECT=... INPUT='帮我写获客稿'"; \
		exit 1; \
	fi
	python3 scripts/session_manager.py --project $(PROJECT) route "$(INPUT)"

session-update:
	@if [ -z "$(SECTION)" ] || [ -z "$(CONTENT)" ]; then \
		echo "用法: make session-update PROJECT=... SECTION=knowledge_log CONTENT='...'"; \
		exit 1; \
	fi
	python3 scripts/session_manager.py --project $(PROJECT) update --section $(SECTION) --content "$(CONTENT)" $(if $(REPLACE),--replace)

session-state:
	python3 scripts/session_manager.py --project $(PROJECT) state

test:
	python3 tests/test_runtime.py
