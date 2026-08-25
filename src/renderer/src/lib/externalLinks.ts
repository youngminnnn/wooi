/** 외부 링크가 서로 다른 표기로 중복되지 않도록 한곳에서 관리한다. */
export const WOOI_URLS = {
  bugReport: 'https://github.com/youngminnnn/wooi/issues/new?template=bug_report.yml',
  featureRequest: 'https://github.com/youngminnnn/wooi/issues/new?template=feature_request.yml',
  releases: 'https://github.com/youngminnnn/wooi/releases',
  // 배포 시 실제 공개 URL 로 교체한다(현재는 앱과 함께 제공되는 repo 문서를 가리킨다).
  privacyPolicy: 'https://github.com/youngminnnn/wooi/blob/main/PRIVACY.md',
  terms: 'https://github.com/youngminnnn/wooi/blob/main/TERMS.md'
} as const
