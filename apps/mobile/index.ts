// **이 import 가 가장 먼저여야 한다.** @noble 은 `globalThis.crypto.getRandomValues` 를
// 모듈 로드 시점에 집어 가는데, React Native 에는 그것이 없다. 폴리필이 늦게 로드되면
// 키 생성이 조용히 실패하는 대신 예외로 터지지만, 그 예외는 페어링 화면에서야 보인다.
import 'react-native-get-random-values'

import { registerRootComponent } from 'expo'

import App from './App'

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App)
