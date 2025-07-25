/**********************************************************************
 * src/gosterge/index.ts
 *
 * Gösterge - Cline Extension JIRA Task Automation System
 * 
 * Bu sistem:
 * - Backend API'den görevleri alır
 * - Cline'a görevleri çözdürür
 * - Git branch yönetimini otomatik yapar
 * - Progress takibi ve hata yönetimi yapar
 * - Concurrent task kontrolü sağlar
 *********************************************************************/

import * as vscode from "vscode";
import fetch, { Headers, Response } from "node-fetch";
import { Controller } from "../core/controller"


/* ------------------------------------------------------------------ */
/* 1. Tip Tanımlamaları                                                */
/* ------------------------------------------------------------------ */

// Cline mesaj tipi
interface ClineMessage {
  say?: string;
  ask?: string;
  type?: string;
  text?: string;
  filesChanged?: number;
  testsRun?: number;
  testsPassed?: number;
}

// Git extension tipleri
type GitExtension = {
  getAPI: (version: number) => GitAPI;
};

type GitAPI = {
  repositories: Repository[];
};

type Repository = {
  state: {
    remotes: Remote[];
    refs: Ref[];
    workingTreeChanges: Change[];
    HEAD?: {
      name?: string;
      commit?: string;
    };
  };
  addRemote: (name: string, url: string) => Promise<void>;
  removeRemote: (name: string) => Promise<void>;
  checkout: (branch: string) => Promise<void>;
  createBranch: (name: string, checkout: boolean) => Promise<void>;
  deleteBranch: (name: string, force?: boolean) => Promise<void>;
  add: (resources: vscode.Uri[]) => Promise<void>;
  commit: (message: string) => Promise<void>;
  push: (remoteName?: string, branchName?: string, setUpstream?: boolean) => Promise<void>;
  pull: () => Promise<void>;
  fetch: (remote?: string, ref?: string, depth?: number) => Promise<void>;
  clean: (paths: string[]) => Promise<void>;
  stage: (uri: vscode.Uri, contents: string) => Promise<void>;
  inputBox: {
    value: string;
  };
};

type Remote = {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
};

type Ref = {
  type: number;
  name?: string;
  commit?: string;
};

type Change = {
  uri: vscode.Uri;
  status: number;
};

/* ------------------------------------------------------------------ */
/* 2. Gösterge Veri Modelleri                                          */
/* ------------------------------------------------------------------ */

type UUID = string;

export interface GostergeTask {
  id: UUID;
  title: string;
  description: string;
  repoUrl: string;
  branch: string;
  priority?: "low" | "medium" | "high" | "urgent";
  estimatedTime?: number; // dakika
  tags?: string[];
  jiraTicket?: string;
  assignee?: string;
}

export interface TaskProgress {
  taskId: UUID;
  percent: number;
  message: string;
  timestamp: number;
  details?: {
    filesChanged?: number;
    testsRun?: number;
    testsPassed?: number;
    linesAdded?: number;
    linesRemoved?: number;
  };
}

export interface TaskResult {
  taskId: UUID;
  branch: string;
  commitHash?: string;
  pullRequestUrl?: string;
  stats?: {
    duration: number; // ms
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
  };
}

export interface TaskFailure {
  taskId: UUID;
  reason: string;
  errorType?: "timeout" | "git" | "cline" | "api" | "unknown";
  stack?: string;
  recoverable?: boolean;
}

/* ------------------------------------------------------------------ */
/* 3. Konfigürasyon                                                    */
/* ------------------------------------------------------------------ */

interface GostergeConfig {
  endpoint: string;
  token: string;
  pollInterval: number;
  taskTimeout: number;
  maxRetries: number;
  cleanWorkspace: boolean;
  autoCommit: boolean;
  branchPrefix: string;
  commitPrefix: string;
  enableHealthCheck: boolean;
  healthCheckInterval: number;
}

function loadConfig(): GostergeConfig {
  const cfg = vscode.workspace.getConfiguration("gosterge");

  // Mock API kullanıldığı için endpoint ve token'a gerek yok
  const endpoint = "mock-api-endpoint";
  const token = "mock-api-token";

  return {
    endpoint,
    token,
    pollInterval: cfg.get<number>("pollInterval") ?? 30_000,
    taskTimeout: cfg.get<number>("taskTimeout") ?? 600_000, // 10 dakika
    maxRetries: cfg.get<number>("maxRetries") ?? 3,
    cleanWorkspace: cfg.get<boolean>("cleanWorkspace") ?? true,
    autoCommit: cfg.get<boolean>("autoCommit") ?? true,
    branchPrefix: cfg.get<string>("branchPrefix") ?? "gosterge/",
    commitPrefix: cfg.get<string>("commitPrefix") ?? "feat: ",
    enableHealthCheck: cfg.get<boolean>("enableHealthCheck") ?? true,
    healthCheckInterval: cfg.get<number>("healthCheckInterval") ?? 60_000,
  };
}

/* ------------------------------------------------------------------ */
/* 4. REST API İstemcisi                                                */
/* ------------------------------------------------------------------ */

import { mockAPI } from './mock-api';

class TaskService {
  private retryCount = new Map<UUID, number>();

  constructor(private config: GostergeConfig) { }

  async next(): Promise<GostergeTask | null> {
    const { task, status } = await mockAPI.getNextTask();
    if (status === 204) return null;
    return task;
  }

  async progress(taskId: UUID, progress: Omit<TaskProgress, "taskId" | "timestamp">): Promise<void> {
    await mockAPI.updateProgress(taskId, progress);
  }

  async complete(taskId: UUID, result: Omit<TaskResult, "taskId">): Promise<void> {
    await mockAPI.completeTask(taskId, result);
  }

  async fail(taskId: UUID, failure: Omit<TaskFailure, "taskId">): Promise<void> {
    await mockAPI.failTask(taskId, failure);
  }

  async health(): Promise<boolean> {
    const { ok } = await mockAPI.health();
    return ok;
  }

  shouldRetry(taskId: UUID): boolean {
    const count = this.retryCount.get(taskId) || 0;
    return count < this.config.maxRetries;
  }

  incrementRetry(taskId: UUID): void {
    const count = this.retryCount.get(taskId) || 0;
    this.retryCount.set(taskId, count + 1);
  }

  resetRetry(taskId: UUID): void {
    this.retryCount.delete(taskId);
  }
}

/* ------------------------------------------------------------------ */
/* 5. Git Servisi - Gelişmiş Özellikler                                */
/* ------------------------------------------------------------------ */

class GitService {
  private api!: GitAPI;
  private repo!: Repository;

  private constructor(
    private readonly config: GostergeConfig,
    private readonly log: vscode.OutputChannel
  ) {}

  static async create(
    config: GostergeConfig,
    log: vscode.OutputChannel
  ): Promise<GitService> {
    const svc = new GitService(config, log);
    await svc.init();
    return svc;
  }

  private async init(): Promise<void> {
    const gitExt =
      vscode.extensions.getExtension<GitExtension>("vscode.git") ??
      vscode.extensions.getExtension<GitExtension>("vscode.git-base");

    if (!gitExt) {
      throw new Error('Git uzantısı bulunamadı (vscode.git)');
    }

    await gitExt.activate();
    this.api = gitExt.exports.getAPI(1);

    // Wait for Git repositories to be discovered
    const maxAttempts = 10;
    let attempts = 0;
    while (this.api.repositories.length === 0 && attempts < maxAttempts) {
      this.log.appendLine(`Git deposu bekleniyor... Deneme ${attempts + 1}/${maxAttempts}`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second
      attempts++;
    }

    if (this.api.repositories.length === 0) {
      throw new Error("Çalışma alanında git deposu bulunamadı veya zaman aşımına uğradı.");
    }

    this.repo = this.api.repositories[0];
  }

  async ensureCleanWorkspace(): Promise<void> {
    const changes = this.repo.state.workingTreeChanges;
    if (changes.length > 0) {
      if (this.config.cleanWorkspace) {
        this.log.appendLine("⚠️ Değişiklikler tespit edildi, temizleniyor...");

        // Önce stage'deki değişiklikleri unstage yap
        this.repo.inputBox.value = "";

        // Tüm değişiklikleri geri al
        for (const change of changes) {
          try {
            await this.repo.clean([change.uri.fsPath]);
          } catch (error) {
            this.log.appendLine(`Dosya temizlenemedi: ${change.uri.fsPath}`);
          }
        }
      } else {
        throw new Error("Çalışma alanında kaydedilmemiş değişiklikler var!");
      }
    }
  }

  async ensureRemote(url: string): Promise<string> {
    // Mevcut remote'ları kontrol et
    const existing = this.repo.state.remotes.find(
      (r: Remote) => r.fetchUrl === url || r.pushUrl === url
    );

    if (existing) return existing.name;

    // Remote ismi oluştur
    const remoteName = `gosterge-${Date.now()}`;

    // Eski gosterge remote'larını temizle
    const oldRemotes = this.repo.state.remotes.filter(
      (r: Remote) => r.name.startsWith("gosterge-")
    );

    for (const oldRemote of oldRemotes) {
      try {
        await this.repo.removeRemote(oldRemote.name);
      } catch {
        // Ignore errors
      }
    }

    await this.repo.addRemote(remoteName, url);
    await this.repo.fetch(remoteName);

    return remoteName;
  }

  async switchToBranch(branch: string, baseBranch = "main"): Promise<void> {
    // Önce base branch'e geç
    try {
      await this.repo.checkout(baseBranch);
      await this.repo.pull();
    } catch (error) {
      this.log.appendLine(`Base branch (${baseBranch}) bulunamadı, mevcut branch kullanılıyor`);
    }

    // Branch adını prefix ile oluştur
    const fullBranchName = `${this.config.branchPrefix}${branch}`;

    // Branch var mı kontrol et
    const exists = this.repo.state.refs.some(
      (r: Ref) => r.name === fullBranchName || r.name === `refs/heads/${fullBranchName}`
    );

    if (exists) {
      // Varsa sil ve yeniden oluştur
      try {
        await this.repo.deleteBranch(fullBranchName, true);
      } catch {
        // Branch silinememişse devam et
      }
    }

    // Yeni branch oluştur
    await this.repo.createBranch(fullBranchName, true);
  }

  async commitChanges(message: string, stats?: any): Promise<string | undefined> {
    const changes = this.repo.state.workingTreeChanges;
    if (!changes.length) {
      this.log.appendLine("Commit yapılacak değişiklik yok");
      return undefined;
    }

    // Tüm değişiklikleri stage'e al
    const uris = changes.map((c: Change) => c.uri);
    await this.repo.add(uris);

    // Detaylı commit mesajı oluştur
    const fullMessage = this.buildCommitMessage(message, stats);
    await this.repo.commit(fullMessage);

    // Commit hash'ini al
    return this.repo.state.HEAD?.commit;
  }

  private buildCommitMessage(message: string, stats?: any): string {
    let fullMessage = `${this.config.commitPrefix}${message}`;

    if (stats) {
      fullMessage += "\n\n";
      fullMessage += "Changes:\n";
      if (stats.filesChanged) fullMessage += `- Files changed: ${stats.filesChanged}\n`;
      if (stats.linesAdded) fullMessage += `- Lines added: ${stats.linesAdded}\n`;
      if (stats.linesRemoved) fullMessage += `- Lines removed: ${stats.linesRemoved}\n`;
      if (stats.testsRun) fullMessage += `- Tests run: ${stats.testsRun}\n`;
      if (stats.testsPassed) fullMessage += `- Tests passed: ${stats.testsPassed}\n`;
    }

    return fullMessage;
  }

  async push(remote: string, branch: string): Promise<void> {
    const fullBranchName = `${this.config.branchPrefix}${branch}`;
    await this.repo.push(remote, fullBranchName, true);
  }

  getCurrentBranch(): string | undefined {
    return this.repo.state.HEAD?.name;
  }

  async getChangeStats(): Promise<any> {
    const changes = this.repo.state.workingTreeChanges;

    return {
      filesChanged: changes.length,
      // Not: Gerçek satır sayıları için diff analizi gerekir
      linesAdded: 0,
      linesRemoved: 0,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 6. Cline Controller Entegrasyonu                                    */
/* ------------------------------------------------------------------ */

class ClineIntegration {
  private controller: Controller;
  private log: vscode.OutputChannel;
  private poller: NodeJS.Timeout | null = null;

  /** En son okunan mesaj sayısı (polling optimizasyonu) */
  private lastMsgCount = 0;

  constructor(controller: Controller, log: vscode.OutputChannel) {
    this.controller = controller;
    this.log = log;
  }

  /**
   * Periodically polls new Cline messages and forwards them to `handler`.
   * Returns a Disposable so callers can stop the polling.
   */
  onMessage(handler: (msg: ClineMessage) => void): vscode.Disposable {
    // Eski poller'ı temizle
    if (this.poller) clearInterval(this.poller);

    // • poll every 500 ms – adjust if you like
    this.poller = setInterval(() => {
      for (const msg of this.pollMessages()) {
        handler(msg);
      }
    }, 500);

    // Return VS Code‑compatible disposable
    return {
      dispose: () => {
        if (this.poller) clearInterval(this.poller);
        this.poller = null;
      },
    };
  }

  /** Clean‑up resources (called by TaskManager) */
  dispose(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  /** Görevi prompt ile başlatır */
  async startTask(task: GostergeTask): Promise<void> {
    const prompt = this.buildTaskPrompt(task);
    await this.controller.initTask(prompt);
    this.lastMsgCount = 0;                    // reset
  }

  /** Controller’daki mesajları oku (polling) */
  pollMessages(): ClineMessage[] {
    const msgs = this.controller?.task?.messageStateHandler?.getClineMessages() ?? [];
    if (msgs.length > this.lastMsgCount) {
      this.lastMsgCount = msgs.length;
      return msgs.slice(-1);                  // sadece yeni geleni döndür
    }
    return [];
  }

  /** Görev tamamlandı mı? */
  isTaskComplete(): boolean {
    return this.controller?.task?.messageStateHandler
      ?.getClineMessages()
      .some((m) => m.say === "completion_result" || m.ask === "completion_result") ?? false;
  }

  /** Görev iptal edildi mi? */
  isTaskAborted(): boolean {
    return !!this.controller?.task?.taskState.abort;
  }

  async abortTask(): Promise<void> {
    await this.controller?.cancelTask();
  }

  /* ------------------------- yardımcılar ------------------------- */

  private buildTaskPrompt(t: GostergeTask): string {
    const lines = [
      t.description,
      "",
      "Görev Detayları:",
      `- Başlık: ${t.title}`,
      t.jiraTicket ? `- JIRA: ${t.jiraTicket}` : "",
      t.priority ? `- Öncelik: ${t.priority}` : "",
      t.tags?.length ? `- Etiketler: ${t.tags.join(", ")}` : "",
      t.estimatedTime ? `- Tahmini süre: ${t.estimatedTime} dk` : "",
      "",
      "Lütfen kod kalitesine ve testlere özen göster.",
    ];
    return lines.filter(Boolean).join("\n");
  }
}


/* ------------------------------------------------------------------ */
/* 7. Task Yöneticisi - Ana Orkestrasyon                               */
/* ------------------------------------------------------------------ */

class TaskManager {
  private config: GostergeConfig;
  private taskService: TaskService;
  private gitService!: GitService; // "!" çünkü init'te atanacak
  private cline: ClineIntegration;
  private log: vscode.OutputChannel;
  
  private busy = false;
  private currentTask: GostergeTask | null = null;
  private taskStartTime = 0;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private abortController: AbortController | null = null;
  private lastProgressUpdate = 0;

  constructor(
    config: GostergeConfig,
    log: vscode.OutputChannel,
    controller: Controller
  ) {
    this.config = config;
    this.log = log;
    this.taskService = new TaskService(config);
    this.cline = new ClineIntegration(controller, log);
  }

  async initialize(context: vscode.ExtensionContext): Promise<void> {
    this.gitService = await GitService.create(this.config, this.log); // GitService'i asenkron oluştur
    // Health check başlat
    if (this.config.enableHealthCheck) {
      this.startHealthCheck();
    }
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      const healthy = await this.taskService.health();
      if (!healthy) {
        this.log.appendLine("⚠️ Backend sağlık kontrolü başarısız!");
      }
    }, this.config.healthCheckInterval);
  }

  async processNextTask(): Promise<void> {
    if (this.busy) {
      this.log.appendLine("⏭️ Başka bir görev işleniyor, atlanıyor...");
      return;
    }

    try {
      // Backend'den görev al
      const task = await this.taskService.next();
      if (!task) {
        return; // Kuyrukta görev yok
      }

      this.busy = true;
      this.currentTask = task;
      this.taskStartTime = Date.now();
      this.abortController = new AbortController();

      this.log.appendLine(`\n${"=".repeat(60)}`);
      this.log.appendLine(`🟢 YENİ GÖREV: ${task.title}`);
      this.log.appendLine(`📋 ID: ${task.id}`);
      this.log.appendLine(`🔗 JIRA: ${task.jiraTicket || "N/A"}`);
      this.log.appendLine(`${"=".repeat(60)}\n`);

      // İlk progress bildirimi
      await this.taskService.progress(task.id, {
        percent: 0,
        message: "Görev başlatılıyor...",
      });

      // Git ortamını hazırla
      await this.prepareGitEnvironment(task);

      // Cline'a görevi ver
      await this.executeClineTask(task);

      // Sonuçları commit et ve push'la
      await this.finalizeTask(task);

      this.log.appendLine(`✅ Görev başarıyla tamamlandı: ${task.id}`);

    } catch (error: any) {
      await this.handleTaskError(error);
    } finally {
      this.busy = false;
      this.currentTask = null;
      this.abortController = null;
    }
  }

  private async prepareGitEnvironment(task: GostergeTask): Promise<void> {
    this.log.appendLine("🔧 Git ortamı hazırlanıyor...");

    // Progress: %10
    await this.taskService.progress(task.id, {
      percent: 10,
      message: "Git workspace temizleniyor...",
    });

    // Workspace'i temizle
    await this.gitService.ensureCleanWorkspace();

    // Remote'u ekle/güncelle
    const remote = await this.gitService.ensureRemote(task.repoUrl);
    this.log.appendLine(`📡 Remote ayarlandı: ${remote}`);

    // Progress: %20
    await this.taskService.progress(task.id, {
      percent: 20,
      message: "Yeni branch oluşturuluyor...",
    });

    // Branch'e geç
    await this.gitService.switchToBranch(task.branch);
    this.log.appendLine(`🌿 Branch oluşturuldu: ${this.config.branchPrefix}${task.branch}`);
  }

  private async executeClineTask(task: GostergeTask): Promise<void> {
    this.log.appendLine("🤖 Cline görevi işliyor...");

    // Progress: %30
    await this.taskService.progress(task.id, {
      percent: 30,
      message: "Cline görevi analiz ediyor...",
    });

    // Cline mesajlarını dinle
    const messageDisposable = this.cline.onMessage(async (msg: ClineMessage) => {
      await this.handleClineMessage(task.id, msg);
    });

    try {
      // Görevi başlat
      await this.cline.startTask(task);

      // Tamamlanmasını bekle (timeout ile)
      await this.waitForCompletion(task.id);

    } finally {
      messageDisposable.dispose();
    }
  }

  private async handleClineMessage(taskId: UUID, message: any): Promise<void> {
    // Progress hesapla
    const percent = this.calculateProgress(message);
    const progressMessage = this.getProgressMessage(message);

    // Backend'e bildir
    await this.taskService.progress(taskId, {
      percent,
      message: progressMessage,
      details: this.extractProgressDetails(message),
    });

    // Log'a yaz
    this.log.appendLine(`📊 [%${percent}] ${progressMessage}`);
  }

  private calculateProgress(message: any): number {
    // Mesaj tipine göre progress hesapla
    if (message.say === "completion_result" || message.ask === "completion_result") {
      return 90;
    } else if (message.say === "api_req_started") {
      return 40;
    } else if (message.say === "api_req_finished") {
      return 50;
    } else if (message.say === "tool_use") {
      return 60;
    } else if (message.type === "file_edit") {
      return 70;
    } else if (message.type === "test_run") {
      return 80;
    }

    return 35; // Default
  }

  private getProgressMessage(message: any): string {
    if (message.text) return message.text;
    if (message.say) return `Cline: ${message.say}`;
    if (message.ask) return `Cline soruyor: ${message.ask}`;
    if (message.type) return `İşlem: ${message.type}`;
    return "Cline çalışıyor...";
  }

  private extractProgressDetails(message: any): any {
    // Mesajdan detay bilgileri çıkar
    const details: any = {};

    if (message.filesChanged) details.filesChanged = message.filesChanged;
    if (message.testsRun) details.testsRun = message.testsRun;
    if (message.testsPassed) details.testsPassed = message.testsPassed;

    return Object.keys(details).length > 0 ? details : undefined;
  }

  private async waitForCompletion(taskId: UUID): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 1000; // 1 saniye

    return new Promise((resolve, reject) => {
      const intervalId = setInterval(async () => {
        // Abort kontrolü
        if (this.abortController?.signal.aborted) {
          clearInterval(intervalId);
          reject(new Error("Görev iptal edildi"));
          return;
        }

        // Tamamlanma kontrolü
        if (this.cline.isTaskComplete()) {
          clearInterval(intervalId);
          resolve();
          return;
        }

        // Hata kontrolü
        if (this.cline.isTaskAborted()) {
          clearInterval(intervalId);
          reject(new Error("Cline görevi iptal etti"));
          return;
        }

        // Timeout kontrolü
        const elapsed = Date.now() - startTime;
        if (elapsed > this.config.taskTimeout) {
          clearInterval(intervalId);
          reject(new Error(`Görev zaman aşımına uğradı (${this.config.taskTimeout / 60000} dk)`));
          return;
        }

        // Her 10 saniyede bir durum güncellemesi
        if (Date.now() - this.lastProgressUpdate >= 10_000) {
          this.lastProgressUpdate = Date.now();
          const remainingTime = Math.ceil((this.config.taskTimeout - elapsed) / 60000);
          await this.taskService.progress(taskId, {
            percent: this.calculateProgress({ type: "waiting" }),
            message: `Cline çalışıyor... (${remainingTime} dk kaldı)`,
          });
        }

      }, checkInterval);
    });
  }

  private async finalizeTask(task: GostergeTask): Promise<void> {
    this.log.appendLine("📦 Görev sonuçları işleniyor...");

    // Progress: %95
    await this.taskService.progress(task.id, {
      percent: 95,
      message: "Değişiklikler commit ediliyor...",
    });

    // Değişiklik istatistiklerini al
    const stats = await this.gitService.getChangeStats();

    // Commit yap
    const commitHash = await this.gitService.commitChanges(task.title, stats);

    if (!commitHash) {
      throw new Error("Commit yapılacak değişiklik bulunamadı!");
    }

    // Progress: %98
    await this.taskService.progress(task.id, {
      percent: 98,
      message: "Değişiklikler push ediliyor...",
    });

    // Push yap
    const remoteName = await this.gitService.ensureRemote(task.repoUrl);
    await this.gitService.push(remoteName, task.branch);

    // Progress: %100
    await this.taskService.progress(task.id, {
      percent: 100,
      message: "Görev tamamlandı!",
    });

    // Görevi tamamla
    const duration = Date.now() - this.taskStartTime;
    await this.taskService.complete(task.id, {
      branch: `${this.config.branchPrefix}${task.branch}`,
      commitHash,
      stats: {
        duration,
        ...stats,
      },
    });

    // Başarı özeti
    this.log.appendLine(`\n${"=".repeat(60)}`);
    this.log.appendLine(`✅ GÖREV TAMAMLANDI`);
    this.log.appendLine(`📌 Commit: ${commitHash.substring(0, 8)}`);
    this.log.appendLine(`🌿 Branch: ${this.config.branchPrefix}${task.branch}`);
    this.log.appendLine(`⏱️ Süre: ${Math.round(duration / 1000)} saniye`);
    this.log.appendLine(`📊 Değişiklikler: ${stats.filesChanged} dosya`);
    this.log.appendLine(`${"=".repeat(60)}\n`);
  }

  private async handleTaskError(error: any): Promise<void> {
    const task = this.currentTask;
    if (!task) return;

    this.log.appendLine(`\n❌ HATA: ${error.message}`);
    if (error.stack) {
      this.log.appendLine(`Stack: ${error.stack}`);
    }

    // Hata tipini belirle
    let errorType: TaskFailure["errorType"] = "unknown";
    let recoverable = false;

    if (error.message.includes("timeout") || error.message.includes("zaman aşımı")) {
      errorType = "timeout";
      recoverable = true;
    } else if (error.message.includes("git") || error.message.includes("Git")) {
      errorType = "git";
      recoverable = true;
    } else if (error.message.includes("Cline") || error.message.includes("controller")) {
      errorType = "cline";
      recoverable = true;
    } else if (error.message.includes("HTTP") || error.message.includes("fetch")) {
      errorType = "api";
      recoverable = true;
    }

    // Retry kontrolü
    if (recoverable && this.taskService.shouldRetry(task.id)) {
      this.taskService.incrementRetry(task.id);
      const retryCount = this.taskService["retryCount"].get(task.id) || 1;

      this.log.appendLine(`🔄 Yeniden deneniyor... (${retryCount}/${this.config.maxRetries})`);

      // Biraz bekle ve yeniden dene
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Görevi sıfırla ve yeniden başlat
      this.busy = false;
      await this.processNextTask();
      return;
    }

    // Backend'e hata bildir
    await this.taskService.fail(task.id, {
      reason: error.message,
      errorType,
      stack: error.stack,
      recoverable,
    });

    // Retry sayacını sıfırla
    this.taskService.resetRetry(task.id);

    // Cline'ı durdur
    try {
      await this.cline.abortTask();
    } catch {
      // Ignore abort errors
    }
  }

  abort(): void {
    this.abortController?.abort();
    this.cline.abortTask();
  }

  dispose(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.cline.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* 8. Ana Başlatma Fonksiyonu                                          */
/* ------------------------------------------------------------------ */

export function initializeGosterge(
  context: vscode.ExtensionContext,
  controller: Controller // Keep controller parameter here for now, as it's passed from extension.ts
): void {
  const log = vscode.window.createOutputChannel("Gosterge");
  context.subscriptions.push(log);

  log.appendLine("🚀 Gösterge başlatılıyor...");
  log.show();
  log.appendLine("🚀 SEZERRRRR.");
  try {
    // Konfigürasyonu yükle
    const config = loadConfig();
    log.appendLine(`⚙️ Endpoint: ${config.endpoint}`);
    log.appendLine(`⏱️ Poll Interval: ${config.pollInterval / 1000}s`);
    log.appendLine(`⏱️ Task Timeout: ${config.taskTimeout / 60000}m`);

    // Task manager oluştur
    const taskManager = new TaskManager(config, log, controller);

    // Başlat
    taskManager.initialize(context).then(() => {
      log.appendLine("✅ Gösterge başarıyla başlatıldı!");

      // Periyodik görev kontrolü
      const processTask = async () => {
        try {
          await taskManager.processNextTask();
        } catch (error: any) {
          log.appendLine(`❌ Görev işleme hatası: ${error.message}`);
        }
      };

      // İlk kontrolü hemen yap
      processTask();

      // Periyodik kontrol başlat
      const intervalId = setInterval(processTask, config.pollInterval);

      // Cleanup
      context.subscriptions.push({
        dispose: () => {
          clearInterval(intervalId);
          taskManager.dispose();
          log.appendLine("👋 Gösterge kapatıldı");
        },
      });

      // Komutları kaydet
      context.subscriptions.push(
        vscode.commands.registerCommand("gosterge.checkNow", () => {
          log.appendLine("🔍 Manuel kontrol tetiklendi");
          processTask();
        })
      );

      context.subscriptions.push(
        vscode.commands.registerCommand("gosterge.abort", () => {
          log.appendLine("🛑 Görev iptal ediliyor...");
          taskManager.abort();
        })
      );

      context.subscriptions.push(
        vscode.commands.registerCommand("gosterge.showLog", () => {
          log.show();
        })
      );

      // --- Test Komutları (Mock API için) ---
      context.subscriptions.push(
        vscode.commands.registerCommand("gosterge.test.addSampleTask", async () => {
          const { addTestTask, resetMockAPI } = await import('./mock-api');
          resetMockAPI(); // Her test görevi eklemede mock'u sıfırla
          addTestTask("Test Görevi 1: Login Formu", "Login formuna 'Beni Hatırla' özelliği ekle.");
          addTestTask("Test Görevi 2: Backend Optimizasyon", "Veritabanı sorgularını optimize et.");
          log.appendLine("✅ Mock test görevleri eklendi.");
          processTask(); // Yeni görevleri kontrol et
        })
      );

      context.subscriptions.push(
        vscode.commands.registerCommand("gosterge.test.simulateFailure", async () => {
          const { simulateAPIFailure } = await import('./mock-api');
          simulateAPIFailure();
          log.appendLine("❌ Mock API hatası simüle ediliyor.");
        })
      );

      context.subscriptions.push(
        vscode.commands.registerCommand("gosterge.test.simulateSlowAPI", async () => {
          const { simulateSlowAPI } = await import('./mock-api');
          simulateSlowAPI();
          log.appendLine("⏳ Mock API yavaşlatılıyor.");
        })
      );

      context.subscriptions.push(
        vscode.commands.registerCommand("gosterge.test.resetMockAPI", async () => {
          const { resetMockAPI } = await import('./mock-api');
          resetMockAPI();
          log.appendLine("🔄 Mock API sıfırlandı.");
        })
      );
      // --- Test Komutları Sonu ---

    }).catch((error) => {
      log.appendLine(`❌ Başlatma hatası: ${error.message}`);
      vscode.window.showErrorMessage(`Gösterge başlatılamadı: ${error.message}`);
    });

  } catch (error: any) {
    log.appendLine(`❌ Kritik hata: ${error.message}`);
    vscode.window.showErrorMessage(`Gösterge kritik hata: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 9. Utility Fonksiyonlar                                              */
/* ------------------------------------------------------------------ */

export function deactivate(): void {
  // Extension kapatılırken çağrılır
  console.log("Gösterge deaktive ediliyor...");
}
