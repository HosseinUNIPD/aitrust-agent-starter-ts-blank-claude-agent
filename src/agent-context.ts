/**
 * Agent Context Store — per-agent private message history.
 *
 * Each agent keeps its own local conversation and chat history built from:
 *   - outgoing messages
 *   - incoming signing callbacks
 *   - local system events
 *
 * No shared Redis dependency.
 */

export interface ContextMessage {
  id: string;
  direction: "outgoing" | "incoming";
  from: string;
  type: "text" | "choice" | "choice_reply" | "attachment" | "signing_request" | "signed" | "rejected" | "payment_request" | "paid" | "system";
  content: string;
  timestamp: string;
  externalMessageId?: string;
  signingInstanceId?: string;
  fileName?: string;
  fileId?: string;
  mediaId?: string;
  choices?: string[];
  selectedChoice?: string;
  signatureImage?: string;
  contentType?: string;
  negotiationRound?: number;
  priceOffered?: number;
  status?: "pending" | "signed" | "rejected" | "paid";
  /** Payout mock — correlation id for a payment card. */
  paymentInstanceId?: string;
  /** Payout mock — amount in major units (e.g. 1850.00). */
  amount?: number;
  /** Payout mock — ISO currency code. */
  currency?: string;
  /** Payout mock — display name of the payee. */
  recipientName?: string;
  /** Payout mock — masked destination account, e.g. "DE89 **** **** 3000". */
  ibanMasked?: string;
  /** Payout mock — simulated transaction reference, set on confirmation. */
  transactionRef?: string;
  metadata?: Record<string, unknown>;
}

export class AgentContext {
  protected messages: ContextMessage[] = [];
  protected counter = 0;
  protected readonly agentId: string;
  protected chatHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  protected nextId(): string {
    return `ctx-${++this.counter}-${Date.now()}`;
  }

  addOutgoing(msg: {
    type: ContextMessage["type"];
    content: string;
    externalMessageId?: string;
    signingInstanceId?: string;
    fileName?: string;
    fileId?: string;
    mediaId?: string;
    choices?: string[];
    negotiationRound?: number;
    priceOffered?: number;
    status?: ContextMessage["status"];
    paymentInstanceId?: string;
    amount?: number;
    currency?: string;
    recipientName?: string;
    ibanMasked?: string;
    transactionRef?: string;
    metadata?: Record<string, unknown>;
  }): ContextMessage {
    const full: ContextMessage = {
      id: this.nextId(),
      direction: "outgoing",
      from: this.agentId,
      type: msg.type,
      content: msg.content,
      timestamp: new Date().toISOString(),
      externalMessageId: msg.externalMessageId,
      signingInstanceId: msg.signingInstanceId,
      fileName: msg.fileName,
      fileId: msg.fileId,
      mediaId: msg.mediaId,
      choices: msg.choices,
      negotiationRound: msg.negotiationRound,
      priceOffered: msg.priceOffered,
      status: msg.status,
      paymentInstanceId: msg.paymentInstanceId,
      amount: msg.amount,
      currency: msg.currency,
      recipientName: msg.recipientName,
      ibanMasked: msg.ibanMasked,
      transactionRef: msg.transactionRef,
      metadata: msg.metadata,
    };
    this.messages.push(full);
    return full;
  }

  addIncoming(msg: {
    from: string;
    type: ContextMessage["type"];
    content: string;
    externalMessageId?: string;
    signingInstanceId?: string;
    fileName?: string;
    fileId?: string;
    mediaId?: string;
    choices?: string[];
    selectedChoice?: string;
    signatureImage?: string;
    contentType?: string;
    status?: ContextMessage["status"];
    metadata?: Record<string, unknown>;
  }): ContextMessage {
    const full: ContextMessage = {
      id: this.nextId(),
      direction: "incoming",
      from: msg.from,
      type: msg.type,
      content: msg.content,
      timestamp: new Date().toISOString(),
      externalMessageId: msg.externalMessageId,
      signingInstanceId: msg.signingInstanceId,
      fileName: msg.fileName,
      fileId: msg.fileId,
      mediaId: msg.mediaId,
      choices: msg.choices,
      selectedChoice: msg.selectedChoice,
      signatureImage: msg.signatureImage,
      contentType: msg.contentType,
      status: msg.status,
      metadata: msg.metadata,
    };
    this.messages.push(full);
    return full;
  }

  addSystemEvent(content: string, metadata?: Record<string, unknown>): ContextMessage {
    const full: ContextMessage = {
      id: this.nextId(),
      direction: "outgoing",
      from: "system",
      type: "system",
      content,
      timestamp: new Date().toISOString(),
      metadata,
    };
    this.messages.push(full);
    return full;
  }

  getMessages(since?: string): ContextMessage[] {
    if (!since) return [...this.messages];
    const sinceTime = new Date(since).getTime();
    return this.messages.filter((message) => new Date(message.timestamp).getTime() > sinceTime);
  }

  getMessagesSync(since?: string): ContextMessage[] {
    return this.getMessages(since);
  }

  getByInstanceId(instanceId: string): ContextMessage | undefined {
    return this.messages.find((message) => message.signingInstanceId === instanceId);
  }

  getByMessageId(messageId: string): ContextMessage | undefined {
    return this.messages.find((message) => message.externalMessageId === messageId);
  }

  getByType(type: ContextMessage["type"]): ContextMessage[] {
    return this.messages.filter((message) => message.type === type);
  }

  get count(): number {
    return this.messages.length;
  }

  addChatTurn(userMessage: string, assistantResponse: string): void {
    this.chatHistory.push({ role: "user", content: userMessage });
    this.chatHistory.push({ role: "assistant", content: assistantResponse });
    if (this.chatHistory.length > 40) {
      this.chatHistory = this.chatHistory.slice(-40);
    }
  }

  getChatHistory(): Array<{ role: "user" | "assistant"; content: string }> {
    return [...this.chatHistory];
  }

  clear(): void {
    this.messages = [];
    this.chatHistory = [];
    this.counter = 0;
  }
}
