require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ElvRemoteKeys'
  s.version        = package['version']
  s.summary        = 'ELV IPTV Apple tvOS raw remote key and directional pan gesture observer'
  s.license        = { :type => package['license'] }
  s.author         = 'ELV IPTV'
  s.homepage       = 'https://github.com/fatihmutluu/elv-iptv'
  s.platforms      = { :ios => '18.0', :tvos => '18.0' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'EXCLUDED_ARCHS[sdk=appletvsimulator*]' => 'x86_64',
    'SWIFT_STRICT_CONCURRENCY' => 'targeted',
  }

  s.source_files = 'Core/**/*.swift', 'Apple/**/*.swift'
end
