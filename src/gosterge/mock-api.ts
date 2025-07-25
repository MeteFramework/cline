/**********************************************************************
 * src/gosterge/mock-api.ts
 *
 * Gösterge Mock Backend API - Test Amaçlı
 * 
 * Bu dosya gerçek backend olmadan Gösterge sistemini test etmek için
 * mock API endpoint'leri sağlar.
 *********************************************************************/

import { GostergeTask, TaskProgress, TaskResult, TaskFailure } from './index';

// Mock veri depoları
let mockTasks: GostergeTask[] = [];
let mockTaskProgress: Map<string, TaskProgress[]> = new Map();
let mockCompletedTasks: Map<string, TaskResult> = new Map();
let mockFailedTasks: Map<string, TaskFailure> = new Map();
let currentTaskIndex = 0;

// Test görevleri oluştur
function initializeMockTasks() {
  mockTasks = [
    {
      id: "task-001",
      title: "Login sayfasına 'Beni Hatırla' checkbox'ı ekle",
      description: "Kullanıcıların oturum açarken 'Beni Hatırla' seçeneğini işaretleyebilmeleri için login formuna checkbox eklenecek. Bu özellik localStorage kullanarak kullanıcı bilgilerini güvenli şekilde saklayacak.",
      repoUrl: "https://github.com/example/webapp.git",
      branch: "feature/remember-me-checkbox",
      priority: "medium",
      estimatedTime: 45,
      tags: ["frontend", "authentication", "ui"],
      jiraTicket: "AUTH-123",
      assignee: "developer@company.com"
    },
    {
      id: "task-002", 
      title: "API rate limiting middleware ekle",
      description: "Express.js backend'ine rate limiting middleware ekleyerek API abuse'ü önle. Her IP için dakikada maksimum 100 request limiti koy.",
      repoUrl: "https://github.com/example/api.git",
      branch: "feature/rate-limiting",
      priority: "high",
      estimatedTime: 60,
      tags: ["backend", "security", "middleware"],
      jiraTicket: "SEC-456",
      assignee: "backend-dev@company.com"
    },
    {
      id: "task-003",
      title: "Dashboard'a kullanıcı aktivite grafiği ekle", 
      description: "Admin dashboard'ına son 30 günlük kullanıcı aktivitesini gösteren interaktif grafik ekle. Chart.js kullanarak günlük aktif kullanıcı sayısını göster.",
      repoUrl: "https://github.com/example/admin-dashboard.git",
      branch: "feature/activity-chart",
      priority: "low",
      estimatedTime: 90,
      tags: ["frontend", "dashboard", "charts"],
      jiraTicket: "DASH-789",
      assignee: "frontend-dev@company.com"
    }
  ];

  console.log(`🎭 Mock API: ${mockTasks.length} test görevi hazırlandı`);
}

// Mock HTTP server simülasyonu
export class MockGostergeAPI {
  private isHealthy = true;
  private responseDelay = 500; // 500ms gecikme simülasyonu

  constructor() {
    initializeMockTasks();
  }

  // Sağlık durumunu değiştir (test için)
  setHealthy(healthy: boolean) {
    this.isHealthy = healthy;
    console.log(`🎭 Mock API: Sağlık durumu ${healthy ? 'iyi' : 'kötü'} olarak ayarlandı`);
  }

  // Response gecikmesini ayarla
  setResponseDelay(ms: number) {
    this.responseDelay = ms;
    console.log(`🎭 Mock API: Response gecikmesi ${ms}ms olarak ayarlandı`);
  }

  // Yeni görev ekle (test için)
  addMockTask(task: GostergeTask) {
    mockTasks.push(task);
    console.log(`🎭 Mock API: Yeni görev eklendi: ${task.title}`);
  }

  // Tüm görevleri temizle
  clearTasks() {
    mockTasks = [];
    currentTaskIndex = 0;
    mockTaskProgress.clear();
    mockCompletedTasks.clear();
    mockFailedTasks.clear();
    console.log(`🎭 Mock API: Tüm görevler temizlendi`);
  }

  // Gecikme simülasyonu
  private async delay(): Promise<void> {
    if (this.responseDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.responseDelay));
    }
  }

  // GET /health
  async health(): Promise<{ ok: boolean; status: number }> {
    await this.delay();
    
    if (!this.isHealthy) {
      console.log(`🎭 Mock API: Health check failed`);
      return { ok: false, status: 503 };
    }
    
    console.log(`🎭 Mock API: Health check OK`);
    return { ok: true, status: 200 };
  }

  // GET /tasks/next
  async getNextTask(): Promise<{ task: GostergeTask | null; status: number }> {
    await this.delay();

    if (currentTaskIndex >= mockTasks.length) {
      console.log(`🎭 Mock API: Kuyrukta görev yok`);
      return { task: null, status: 204 };
    }

    const task = mockTasks[currentTaskIndex];
    currentTaskIndex++;
    
    console.log(`🎭 Mock API: Görev döndürüldü: ${task.title} (${currentTaskIndex}/${mockTasks.length})`);
    return { task, status: 200 };
  }

  // POST /tasks/{id}/progress
  async updateProgress(taskId: string, progress: Omit<TaskProgress, "taskId" | "timestamp">): Promise<{ status: number }> {
    await this.delay();

    const fullProgress: TaskProgress = {
      taskId,
      ...progress,
      timestamp: Date.now()
    };

    if (!mockTaskProgress.has(taskId)) {
      mockTaskProgress.set(taskId, []);
    }
    mockTaskProgress.get(taskId)!.push(fullProgress);

    console.log(`🎭 Mock API: Progress güncellendi: ${taskId} - %${progress.percent} - ${progress.message}`);
    return { status: 200 };
  }

  // POST /tasks/{id}/complete
  async completeTask(taskId: string, result: Omit<TaskResult, "taskId">): Promise<{ status: number }> {
    await this.delay();

    const fullResult: TaskResult = {
      taskId,
      ...result
    };

    mockCompletedTasks.set(taskId, fullResult);
    console.log(`🎭 Mock API: Görev tamamlandı: ${taskId} - Branch: ${result.branch}`);
    return { status: 200 };
  }

  // POST /tasks/{id}/fail
  async failTask(taskId: string, failure: Omit<TaskFailure, "taskId">): Promise<{ status: number }> {
    await this.delay();

    const fullFailure: TaskFailure = {
      taskId,
      ...failure
    };

    mockFailedTasks.set(taskId, fullFailure);
    console.log(`🎭 Mock API: Görev başarısız: ${taskId} - ${failure.reason}`);
    return { status: 200 };
  }

  // Test için durum bilgilerini al
  getStats() {
    return {
      totalTasks: mockTasks.length,
      processedTasks: currentTaskIndex,
      remainingTasks: mockTasks.length - currentTaskIndex,
      completedTasks: mockCompletedTasks.size,
      failedTasks: mockFailedTasks.size,
      progressUpdates: Array.from(mockTaskProgress.values()).reduce((sum, arr) => sum + arr.length, 0)
    };
  }

  // Tüm progress geçmişini al
  getProgressHistory(taskId?: string) {
    if (taskId) {
      return mockTaskProgress.get(taskId) || [];
    }
    return Object.fromEntries(mockTaskProgress.entries());
  }

  // Tamamlanan görevleri al
  getCompletedTasks() {
    return Object.fromEntries(mockCompletedTasks.entries());
  }

  // Başarısız görevleri al
  getFailedTasks() {
    return Object.fromEntries(mockFailedTasks.entries());
  }
}

// Global mock API instance
export const mockAPI = new MockGostergeAPI();

// Test helper fonksiyonları
export function resetMockAPI() {
  mockAPI.clearTasks();
  mockAPI.setHealthy(true);
  mockAPI.setResponseDelay(500);
  initializeMockTasks();
}

export function simulateAPIFailure() {
  mockAPI.setHealthy(false);
  console.log(`🎭 Mock API: API failure simülasyonu başlatıldı`);
}

export function simulateSlowAPI() {
  mockAPI.setResponseDelay(3000);
  console.log(`🎭 Mock API: Yavaş API simülasyonu başlatıldı`);
}

export function addTestTask(title: string, description: string) {
  const task: GostergeTask = {
    id: `test-${Date.now()}`,
    title,
    description,
    repoUrl: "https://github.com/test/repo.git",
    branch: `test-${Date.now()}`,
    priority: "medium",
    estimatedTime: 30,
    tags: ["test"],
    jiraTicket: `TEST-${Math.floor(Math.random() * 1000)}`,
    assignee: "test@example.com"
  };
  
  mockAPI.addMockTask(task);
  return task;
}
