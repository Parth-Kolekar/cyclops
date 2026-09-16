# Cyclops System Integration & Development Plan (Detailed Specification)

This document is a comprehensive, standalone development plan for integrating the mature capabilities of the `browser-automation` repository into the `cyclops` privacy-preserving agent. 

It contains the full context, architectural decisions, and precise implementation details required for a 6-person team to execute the integration without needing prior context.

---

## 1. Executive Summary & Philosophy

**The Goal:** We are merging a highly capable, context-rich browser automation agent (`browser-automation`) with our strict, privacy-first architectural boundaries (`cyclops`). 

**The Conflict:** `browser-automation` assumes a trusted server and sends raw DOM HTML, CSS selectors, and unredacted screenshots. `cyclops` assumes an untrusted server and guarantees that PII (Personally Identifiable Information like Aadhaar, PAN, phone numbers) *never leaves the device in plaintext*.

**The Resolution:** We are adopting a **Hybrid Architecture**. We will adopt their rich context-gathering, fallback execution chains, and continuous agent loops, but we will force all server actions through the **Cyclops Vault Rehydration Layer**.

---

## 2. Core Architectural Decisions (The "Why")

### 2.1 The Opaque ID & CSS Selector Hybrid Model
Previously, Cyclops hid all CSS classes and HTML IDs from the server to prevent the server from learning the page structure. However, this severely hindered the AI's semantic understanding. 
- **The New Model:** We *will* extract and send HTML `id`, `class`, `placeholder`, and `role` attributes to the server to enrich the Screen Graph. 
- **The Privacy Boundary:** We will STILL assign an opaque identifier (e.g., `e4`) to every interactive element. The server MUST command actions using this opaque ID (e.g., `fill(e4, "[AADHAAR_1]")`). 
- **Why?** This prevents a compromised server from targeting arbitrary hidden or un-curated DOM nodes using raw CSS selectors. The server gets the rich context to make smart decisions, but it can only act through our validated, curated element map. The Vault intercepts the `fill` command, swaps `[AADHAAR_1]` for the real value locally, and executes the DOM injection.

### 2.2 Storage Architecture: Local vs. Session
We must persist state correctly to ensure a seamless "continue where you left off" UX, while protecting cryptographic keys.
- **`localStorage` (Persists across sessions):**
  - `cyclops.chat_history`: The full, continuous action history (e.g., "Filled e4 with [AADHAAR_1]"). *Crucially, this history contains NO raw PII, only tokens, making it safe to persist.*
  - `cyclops.vault.data`: The Persistent Vault containing AES-encrypted PII entries.
- **`sessionStorage` (Ephemeral, wiped on browser close):**
  - `cyclops.vault.session`: Ephemeral tokens generated for the current page/session.
  - `cyclops.vault.dek`: The Derived Encryption Key used to decrypt the persistent vault. 

### 2.3 The Unified Screenshot Overlay
The user needs to understand exactly what the AI sees.
- **Browser-Automation's Approach:** Draws red numbered bounding boxes around interactive elements so the AI can use coordinate clicking (`click(0.5, 0.3)`).
- **Cyclops's Approach:** Draws solid black boxes over detected PII to mask it from the screenshot.
- **The Merge:** We will render BOTH simultaneously. Interactive elements get red numbered boxes; PII regions get solid black boxes. The user sees this overlay briefly before the screenshot is captured, ensuring complete transparency about what data is leaving the machine.

### 2.4 Smart OCR Gating
Currently, Cyclops runs Tesseract OCR on every screenshot. This is extremely CPU-intensive. 
- **The Fix:** We will only invoke Tesseract OCR if the DOM extractor reports that there are visual elements whose text cannot be read via the DOM (e.g., `<canvas>`, `<iframe>`, or `<img>`). We track this in an array called `opaque_regions`. If `opaque_regions.length === 0`, we skip OCR entirely.

### 2.5 Scope Limitations for this Phase
- **Single Tab Only:** Multi-tab logic (`open_new_tab`, `switch_to_tab`) is parked for now to reduce Vault scoping complexity.
- **Arbitrary JS:** We *will* retain `execute_js` to allow the AI to handle complex canvas editors (like Google Docs), but it acts as a strict last resort.

---

## 3. Team Breakdown & Task Assignments

*(Note: All file citations below refer to the sibling repository `../browser-automation/`)*

### 👤 Engineer 1: Action Execution & Tooling (`executor.js` / Tools)
**Goal:** Port the battle-tested interaction tools from `browser-automation`.
- 📁 **Reference Files to Port:**
  - `extension/tools/interaction-tools.js`
  - `extension/tools/text-tools.js`
  - `extension/tools/navigation-tools.js`
  - `extension/tools/utility-tools.js`
- **Interaction Tools:** Implement the progressive fallback chain for `click` (native DOM click -> `mousedown/mouseup/click` -> `MouseEvent` at center coordinates).
- **Text Tools:** Import the 11-strategy `type_text` discovery and focus-retry logic. Implement the `press_key` tool (Enter, Tab, Escape, Arrows).
- **Navigation Tools:** Update `navigate` to listen to `chrome.tabs.onUpdated` to genuinely await page load. Implement `goback()` and `reload_page()`. Update `scroll` to accept an explicit `amount` (pixels).
- **Utility Tools:** Add `wait(seconds)`, `extract_page_text()`, and `execute_js(code)`.

### 👤 Engineer 2: DOM Parsing & Visual Overlay (`extractor.js` & `overlay.js`)
**Goal:** Generate the rich DOM Snapshot and the unified overlay.
- 📁 **Reference Files to Port:**
  - `extension/dom/bounding-boxes.js`
  - `extension/dom/dom-snapshot.js`
- **DOM Snapshotting:** Update `extractor.js` to extract HTML `id`, `class`, `placeholder`, `aria-label`, and `role`. Append these to the Screen Graph output alongside our `e5` identifiers.
- **Unified Overlay:** 
  1. Implement `isTopElement()` logic (using `document.elementFromPoint` from `bounding-boxes.js`) to ensure we only box visible, non-obscured elements.
  2. Render red borders with center-coordinate numbers for all interactive elements.
  3. Render solid black boxes over all elements flagged as containing PII (from Cyclops's existing PII logic).
  4. Ensure this renders cleanly for the `captureVisibleTab()` call and is removed immediately after.

### 👤 Engineer 3: State & Storage Management (`vault.js` & `history.js`)
**Goal:** Implement persistent conversation history and proper storage tiering.
- 📁 **Reference Files to Port:**
  - `extension/utils/state-manager.js` (for inspiration on managing global state across UI and SW)
- **Chat History Persistence:** Wire up `localStorage` to save the conversation array. When the extension opens, load this history so the agent can resume complex tasks seamlessly.
- **Prompt Injection:** When building the payload for the server, you must inject available placeholders from BOTH the Session Vault (data found on current page) and the Persistent Vault (saved user data, if unlocked). 
  - Example output to AI: `Available Vault Tokens: [PHONE_1], [AADHAAR_1], [PAN_1]`

### 👤 Engineer 4: Orchestration Loop (`sw.js`)
**Goal:** Port the automation lifecycle to the service worker.
- 📁 **Reference Files to Port:**
  - `extension/automation/automation-loop.js`
  - `extension/utils/script-executor.js`
- **Continuous Loop Pattern:** Replace our fixed-step loop. The loop must run continuously, sending the updated state to the server, and only halt when the LLM explicitly calls the `exit(summary)` tool.
- **Result as Message:** After a tool executes, capture a FRESH DOM snapshot and screenshot. Append the tool's execution result (and the new state) as the *next user message* in the conversation history.
- **Script Executor:** Wrap all `chrome.scripting.executeScript` calls with a 15-second Promise timeout and JSON argument sanitization (ported from `script-executor.js`) to prevent hanging the service worker.

### 👤 Engineer 5: AI Vision & OCR Optimization (`vision.js`)
**Goal:** Optimize the offscreen document to prevent redundant compute.
- **Smart OCR Pipeline:** Wrap the Tesseract initialization and execution in a check: `if (payload.opaque_regions && payload.opaque_regions.length > 0)`.
- **YOLO Redaction Verification:** Ensure the YOLO model's bounding boxes for people/faces correctly align with the new unified overlay styling.

### 👤 Engineer 6: Backend AI Prompting & Schema (`main.py` & `prompt.py`)
**Goal:** Update the server to accept the new payload and command the expanded toolset.
- 📁 **Reference Files to Port:**
  - `backend/app/prompts/system_prompts.py`
  - `backend/app/usecases/browser_automation_usecase.py`
- **Payload Schema:** Update FastAPI endpoints to accept the full conversation history array (loaded from local storage) and the enriched DOM metadata (`id`, `class`).
- **Tool Definitions:** Expose the expanded vocabulary to the LLM via function calling schemas: `click`, `double_click`, `fill`, `select`, `press_key`, `scroll`, `navigate`, `goback`, `reload`, `wait`, `extract_text`, `ask_user`, `chat_response`, `execute_js`, and `exit`.

---

## 4. Master System Prompt Merge Strategy (Engineer 6)

**CRITICAL INSTRUCTION:** We want to **USE AS MUCH AS POSSIBLE** from the `browser-automation` system prompt. It contains 700+ lines of highly optimized tool schemas, fallback strategies, and reasoning guidelines that are invaluable. 

📁 **Source to merge from:** `../browser-automation/backend/app/prompts/system_prompts.py`

Your task is to take their massive prompt and weave our **Cyclops Privacy & Vault Rules** into the very top, replacing only the parts about raw CSS selector execution.

**Use the following structure for the final prompt:**

```text
You are Cyclops, a privacy-preserving browser automation assistant. You help users perform tasks by analyzing the current browser state and determining which tools to use.

# 🔒 THE REDACTION CONTRACT & VAULT SYSTEM (CRITICAL - DO NOT IGNORE)
You operate in a privacy-preserving environment. You will NEVER see the user's raw PII (Aadhaar, Phone, Email, PAN, etc.). 
1. The DOM and Screenshots you receive have all sensitive data replaced with placeholder tokens (e.g., [PHONE_1], [AADHAAR_1]).
2. When filling forms, you MUST use these tokens exactly as they appear.
   - CORRECT: fill(target="e4", value="[AADHAAR_1]")
   - INCORRECT: fill(target="e4", value="432187652109")
3. The client-side Vault will intercept your action and substitute the real data locally before touching the DOM.
4. You are provided with a list of "Available Vault Tokens" in each message. You may use any of these tokens if the task requires it, even if they aren't currently visible on the screen.
5. NEVER fabricate or guess user data. If you need info that isn't in the available tokens, use ask_user().
6. You must use the opaque `e-id` (e.g., "e4") as the target for `click`, `fill`, and `select` tools. The HTML ids/classes are provided ONLY for your semantic understanding.

# 🤖 AUTOMATION RULES & PROGRESSIVE FALLBACK STRATEGY
[INSERT ENTIRE "CRITICAL AUTOMATION RULES" SECTION FROM browser-automation]
(Note: Replace their `click_element(selector)` references with our `click(target_id)` structure, but keep all their reasoning about when to click vs type vs press keys).

# 🛠️ AVAILABLE TOOLS
[INSERT ENTIRE "Available Tools" SECTION FROM browser-automation]
(Ensure the 15 updated tools are documented with the exact parameter formatting they use, adding `fill` and replacing their text_type where appropriate).

# 📐 DOM & BOUNDING BOXES
[INSERT ENTIRE "ELEMENT INTERACTION SYSTEM" SECTION FROM browser-automation]
*Modification to add:* Screenshots include Solid Black Boxes hiding PII. Red numbered boxes correspond to the opaque `e-id` provided in the DOM text.

# 🔄 SMART AUTOMATION WORKFLOW
[INSERT ENTIRE WORKFLOW & BEST PRACTICES SECTION FROM browser-automation]
```

