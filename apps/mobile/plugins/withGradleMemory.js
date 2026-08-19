const { withGradleProperties } = require('expo/config-plugins')

/**
 * Gradle 데몬의 JVM 메모리를 올린다.
 *
 * Expo 가 prebuild 로 만들어 주는 `android/gradle.properties` 기본값은 이렇다:
 *
 *     org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m
 *
 * 이 프로젝트는 512 MiB 로 KSP 를 못 끝낸다. `expo-updates` 의 어노테이션 처리에서 터진다:
 *
 *     The currently configured max heap space is '2 GiB' and the configured max metaspace is '512 MiB'.
 *     e: [ksp] java.lang.OutOfMemoryError: Metaspace
 *     Execution failed for task ':expo-updates:kspReleaseKotlin'
 *
 * EAS 클라우드 빌드에서는 이 문제가 안 보였는데, 그쪽 빌드 이미지가 이 값을 따로 올려 두기
 * 때문이다. 그래서 빌드를 우리 러너로 가져오자마자 드러났다 — 원래 있던 한계가 EAS 의 환경에
 * 가려져 있었을 뿐이다. 값을 레포에 두면 어디서 굽든 같게 동작한다.
 *
 * 빌드 타임 설정이라 앱 바이너리에는 영향이 없다.
 */
module.exports = function withGradleMemory(config) {
  return withGradleProperties(config, (cfg) => {
    const key = 'org.gradle.jvmargs'
    const value = '-Xmx4096m -XX:MaxMetaspaceSize=2048m -XX:+HeapDumpOnOutOfMemoryError'

    cfg.modResults = cfg.modResults.filter(
      (item) => !(item.type === 'property' && item.key === key)
    )
    cfg.modResults.push({ type: 'property', key, value })
    return cfg
  })
}
