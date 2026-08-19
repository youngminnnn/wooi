# Expo HAS CHANGED

이 앱이 쓰는 SDK 버전의 문서를 **정확히 그 버전으로** 읽는다. 기억이나 최신 문서로 쓰면
안 된다 — Expo 는 SDK 사이에 API 와 config plugin 동작이 바뀐다.

**현재: Expo SDK 54** — https://docs.expo.dev/versions/v54.0.0/

`package.json` 의 `expo` 가 단일 소스다. 올릴 때 이 줄도 같이 고친다.

```sh
node -p "require('./package.json').dependencies.expo"
```

버전이 어긋나면 조용히 틀린 코드를 쓰게 된다. 실제로 `app.json` 의
`expo-camera` 플러그인 옵션 `recordAudioAndroid: false` 로 권한이 빠질 거라 믿었다가,
라이브러리 매니페스트가 병합되는 걸 놓쳐 마이크 권한을 스토어에 내걸 뻔했다.
설정을 바꿨으면 **빌드해서 병합 결과를 확인한다**(README 의 "쓰지도 않는 권한은 막는다").
