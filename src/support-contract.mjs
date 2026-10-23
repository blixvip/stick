// Shared limits are ceilings, not a billing meter. Server settings may only lower them.
export const SUPPORT_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024, imageBytes: 4 * 1024 * 1024,
  threadFileBytes: 24 * 1024 * 1024, filesPerThread: 6,
  storageBytes: 512 * 1024 * 1024, textBytes: 24 * 1024 * 1024,
  threads: 2000, messages: 20000, messagesPerThread: 150,
  storedFiles: 6000,
  dailyRequests: 3000, dailyReads: 750000, dailyWrites: 16000,
  dailyUploads: 100, dailyDownloads: 600,
  retentionDays: 90, fileRetentionDays: 30, pageSize: 30,
});
export const SUPPORT_CATEGORIES = Object.freeze({ bug: 'Bug report', performance: 'Performance', idea: 'Idea or suggestion', other: 'Other feedback' });
export const SUPPORT_STATUSES = Object.freeze({ new: 'New', triaged: 'Under review', waiting: 'Waiting for you', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed', spam: 'Spam' });
export const SUPPORT_PRIORITIES = Object.freeze({ low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' });
export function supportFileType(name) {
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', styk: 'application/octet-stream' })[String(name).split('.').pop().toLowerCase()] || null;
}
export function supportFileName(value) {
  return String(value).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_').slice(0, 100);
}
export function supportError(error) {
  return ({
    support_paused: 'New reports are temporarily paused. You can still read your conversations.',
    support_capacity_reached: 'The report inbox is at capacity. Your draft is safe here; please try again later.',
    support_budget_reached: 'The daily support allowance has been reached. Please return after midnight UTC.',
    rate_limited: 'Please wait a minute before trying again.',
    actor_limit_reached: 'You have reached today’s support limit. Please return tomorrow.',
    not_found: 'This conversation is unavailable, expired, or belongs to another private inbox.',
    report_locked: 'This conversation is closed. You can still read it.',
    stale_report: 'This report changed in another session. Refresh it before saving your changes.',
    attachment_storage_unavailable: 'Attachments are temporarily unavailable. Your message can still be sent.',
    attachment_capacity_reached: 'There is not enough attachment space. Send your message without this file.',
    attachment_in_progress: 'This file upload is still being checked. Refresh before trying again.',
    invalid_file: 'Choose a PNG, JPEG or WebP image, an MP4 or WebM video, or a .styk project. Upload limits: images 4 MB; videos and projects 8 MB.',
    media_source_large: 'Choose an image under 32 MB or a video under 100 MB.',
    media_output_large: 'This file is still too large after compression. Use a smaller image or shorter video.',
    media_decode_failed: 'This media could not be processed. Try exporting it as PNG, MP4 or WebM.',
    video_too_long: 'To compress this video, trim it to 60 seconds or less.',
    video_compression_unavailable: 'Video compression is unavailable in this browser. Choose a video under 8 MB.',
    invalid_report: 'Please complete the title, description, and reproduction details for your report.',
    invalid_message: 'Write a message of 1–4,000 characters.',
    authentication_required: 'Your administrator session expired. Sign in again.',
    payload_too_large: 'That file or message is too large.',
    service_unavailable: 'Support is temporarily unavailable. Your draft has been kept. Please try again.',
  })[error?.code || error?.message] || 'Could not complete the request. Your draft has been kept; check your connection and try again.';
}
