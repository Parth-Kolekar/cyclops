/**
 * TODO(Engineer 3): Manage persistent conversation history
 * 
 * Responsibilities:
 * - Load/save chat history to chrome.storage.local
 * - Allow the agent to resume across sessions
 */

export const ChatHistory = {
    async save(historyArray) {
        // Must ensure NO plaintext PII is in this array (should only be vault tokens)
        await chrome.storage.local.set({ 'cyclops.chat_history': historyArray });
    },
    
    async load() {
        const data = await chrome.storage.local.get('cyclops.chat_history');
        return data['cyclops.chat_history'] || [];
    },
    
    async clear() {
        await chrome.storage.local.remove('cyclops.chat_history');
    }
};

