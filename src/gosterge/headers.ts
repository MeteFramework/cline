// Gösterge'den gelen custom header değerleri
// Bu değerler tüm OpenAI uyumlu provider'lara header olarak gönderilecek
export const GOSTERGE_CUSTOM_HEADERS: Record<string, string> = {
	AtrTaskId: "", // Görev ID'si - dinamik olarak güncellenecek
	clineWorkerId: "", // Worker ID'si - dinamik olarak güncellenecek
}
